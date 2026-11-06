import {
  MediaStream,
  mediaDevices,
  RTCIceCandidate,
  RTCPeerConnection,
  RTCSessionDescription,
} from 'react-native-webrtc';
import { rtcApi } from '../api/endpoints';

const PEER_STATE_LABELS = {
  new: 'connecting',
  connecting: 'connecting',
  connected: 'connected',
  disconnected: 'reconnecting',
  failed: 'failed',
  closed: 'closed',
};

/**
 * Audio-only WebRTC mesh. Every approved speaker publishes a single microphone
 * track to every other member in the room. Audience members only receive.
 * Server-side permission checks remain authoritative: the signalling endpoint
 * rejects offers from members without microphone approval.
 *
 * To avoid offer glare between two speakers, only the lexicographically lower
 * user id creates the initial offer for a speaker-to-speaker pair. A publisher
 * always offers to non-publishers because an audience device never initiates.
 */
export class VoiceEngine {
  constructor({
    socket,
    emitAck,
    roomId,
    userId,
    onRemoteStream,
    onLocalStream,
    onState,
    onError,
  }) {
    this.socket = socket;
    this.emitAck = emitAck;
    this.roomId = roomId;
    this.userId = userId;
    this.onRemoteStream = onRemoteStream;
    this.onLocalStream = onLocalStream;
    this.onState = onState;
    this.onError = onError;
    this.localStream = null;
    this.canPublish = false;
    this.active = false;
    this.members = [];
    this.peers = new Map();
    this.pendingCandidates = new Map();
    this.iceServers = [{ urls: 'stun:stun.l.google.com:19302' }];
    this.remoteStreams = new Map();
    this.startedAt = Date.now();
  }

  updateMembers(members = []) {
    this.members = members;
    if (!this.active) return;
    this._syncOutgoingOffers().catch((error) => this._report(error));
  }

  async start(members = []) {
    if (this.active) {
      this.updateMembers(members);
      return;
    }
    this.active = true;
    this.members = members;
    try {
      const config = await rtcApi.config();
      if (config?.iceServers?.length) this.iceServers = config.iceServers;
    } catch {
      // Public STUN is a fallback only. TURN is strongly recommended for
      // symmetric NAT and is configured through the server environment.
    }
    this._emitState();
  }

  async enableMic() {
    if (!this.active) return;
    try {
      this.localStream = await mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
        video: false,
      });
      this.canPublish = true;
      this.onLocalStream?.(this.localStream);
      // Recreate peer connections so both sides renegotiate cleanly after a
      // permission change, and so every participant receives the new track.
      this._closeAllPeers({ keepRemoteAudio: false });
      await this._syncOutgoingOffers(true);
      this._emitState();
    } catch (error) {
      this.canPublish = false;
      const wrapped = new Error(
        error?.message?.includes('Permission')
          ? 'Microphone permission was denied. Enable it in system settings.'
          : 'Unable to start the microphone.',
      );
      wrapped.code = 'MIC_START_FAILED';
      this._report(wrapped);
      this._emitState();
    }
  }

  async disableMic() {
    this.canPublish = false;
    if (this.localStream) {
      this.localStream.getTracks().forEach((track) => track.stop());
      this.localStream.release?.();
      this.localStream = null;
    }
    this.onLocalStream?.(null);
    for (const peer of this.peers.values()) {
      try {
        for (const sender of peer.getSenders()) {
          if (sender.track?.kind === 'audio') {
            await sender.replaceTrack(null);
          }
        }
      } catch {
        // A closed peer needs no replacement track.
      }
    }
    this._emitState();
  }

  async _syncOutgoingOffers(force = false) {
    if (!this.active || !this.canPublish) return;
    for (const member of this.members) {
      if (!member || String(member.userId) === String(this.userId)) continue;
      if (member.status && member.status !== 'active') continue;
      const targetPublishes = Boolean(
        member.permissions?.canSpeak && !member.permissions?.mutedByHost,
      );
      const shouldInitiate = !targetPublishes || String(this.userId) < String(member.userId);
      if (!shouldInitiate) continue;
      if (!force && this.peers.has(String(member.userId))) continue;
      await this._createOffer(member);
    }
  }

  _newPeer(targetUserId) {
    const pc = new RTCPeerConnection({
      iceServers: this.iceServers,
      bundlePolicy: 'max-bundle',
      iceCandidatePoolSize: 4,
    });
    const key = String(targetUserId);
    pc.onicecandidate = (event) => {
      if (event.candidate) {
        this._signal(targetUserId, {
          type: 'ice-candidate',
          candidate: event.candidate.toJSON ? event.candidate.toJSON() : event.candidate,
        }).catch((error) => this._report(error));
      }
    };
    const handleStream = (stream) => {
      if (!stream) return;
      this.remoteStreams.set(key, stream);
      this.onRemoteStream?.(targetUserId, stream);
      this._emitState();
    };
    pc.onaddstream = (event) => handleStream(event.stream);
    pc.ontrack = (event) => {
      if (event.streams?.[0]) handleStream(event.streams[0]);
      else handleStream(new MediaStream([event.track]));
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed') {
        this._closePeer(targetUserId);
      }
      this._emitState();
    };
    if (this.localStream && this.canPublish) {
      this._addLocalTracks(pc);
    }
    this.peers.set(key, pc);
    return pc;
  }

  _addLocalTracks(pc) {
    if (!this.localStream) return;
    const existing = new Set(pc.getSenders().map((sender) => sender.track?.id).filter(Boolean));
    this.localStream.getAudioTracks().forEach((track) => {
      if (!existing.has(track.id)) pc.addTrack(track, this.localStream);
    });
  }

  async _createOffer(member) {
    const key = String(member.userId);
    if (this.peers.has(key)) return;
    const pc = this._newPeer(member.userId);
    try {
      const offer = await pc.createOffer({
        offerToReceiveAudio: true,
        offerToReceiveVideo: false,
      });
      await pc.setLocalDescription(offer);
      await this._signal(member.userId, {
        type: 'offer',
        sdp: pc.localDescription?.toJSON ? pc.localDescription.toJSON() : pc.localDescription,
        sessionId: `${this.startedAt}-${key}`,
      });
    } catch (error) {
      this._closePeer(member.userId);
      this._report(error);
    }
  }

  async receiveSignal({ fromUserId, data }) {
    if (!this.active || !data) return;
    const key = String(fromUserId);
    try {
      if (data.type === 'offer') {
        let pc = this.peers.get(key);
        if (!pc) pc = this._newPeer(key);
        if (pc.signalingState !== 'stable' && pc.signalingState !== 'have-local-offer') {
          // An existing peer that is already stable can accept a renegotiation
          // without being recreated.
        }
        if (pc.signalingState === 'have-local-offer') {
          // Perfect negotiation fallback: the peer with the lower id wins.
          if (String(this.userId) < key) return;
          await pc.setLocalDescription({ type: 'rollback' });
        }
        await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
        if (this.localStream && this.canPublish) this._addLocalTracks(pc);
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        await this._flushCandidates(key, pc);
        await this._signal(fromUserId, {
          type: 'answer',
          sdp: pc.localDescription?.toJSON ? pc.localDescription.toJSON() : pc.localDescription,
          sessionId: data.sessionId || null,
        });
      } else if (data.type === 'answer') {
        const pc = this.peers.get(key);
        if (!pc) return;
        if (pc.signalingState === 'have-local-offer') {
          await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
          await this._flushCandidates(key, pc);
        }
      } else if (data.type === 'ice-candidate' && data.candidate) {
        const pc = this.peers.get(key);
        const candidate = new RTCIceCandidate(data.candidate);
        if (pc?.remoteDescription) {
          await pc.addIceCandidate(candidate);
        } else {
          const queue = this.pendingCandidates.get(key) || [];
          queue.push(candidate);
          this.pendingCandidates.set(key, queue);
        }
      } else if (data.type === 'bye') {
        this._closePeer(key);
      }
    } catch (error) {
      this._report(error);
    }
  }

  async _flushCandidates(key, pc) {
    const queue = this.pendingCandidates.get(key) || [];
    this.pendingCandidates.delete(key);
    for (const candidate of queue) {
      try {
        await pc.addIceCandidate(candidate);
      } catch {
        // Stale candidates from a previous negotiation can safely be skipped.
      }
    }
  }

  _signal(targetUserId, data) {
    return this.emitAck('webrtc:signal', {
      roomId: this.roomId,
      targetUserId: String(targetUserId),
      data,
    });
  }

  _closePeer(targetUserId) {
    const key = String(targetUserId);
    const pc = this.peers.get(key);
    if (pc) {
      try {
        pc.close();
      } catch {
        // Already closed.
      }
      this.peers.delete(key);
    }
    this.pendingCandidates.delete(key);
    if (this.remoteStreams.has(key)) {
      this.remoteStreams.delete(key);
      this.onRemoteStream?.(targetUserId, null);
      this._emitState();
    }
  }

  _closeAllPeers() {
    for (const key of [...this.peers.keys()]) this._closePeer(key);
  }

  getRemoteStream(targetUserId) {
    return this.remoteStreams.get(String(targetUserId)) || null;
  }

  snapshot() {
    const connectedPeers = [...this.peers.values()].filter(
      (peer) => peer.connectionState === 'connected',
    ).length;
    const states = [...this.peers.values()].map(
      (peer) => PEER_STATE_LABELS[peer.connectionState] || 'connecting',
    );
    return {
      active: this.active,
      canPublish: this.canPublish,
      publishing: Boolean(this.localStream && this.canPublish),
      localStream: this.localStream,
      peerCount: this.peers.size,
      connectedPeers,
      remoteSpeakerIds: [...this.remoteStreams.keys()],
      status: !this.active
        ? 'idle'
        : connectedPeers > 0
          ? 'connected'
          : states.includes('failed')
            ? 'failed'
            : 'connecting',
    };
  }

  _emitState() {
    this.onState?.(this.snapshot());
  }

  _report(error) {
    this.onError?.(error);
  }

  async stop() {
    this.active = false;
    this.canPublish = false;
    for (const member of this.members) {
      if (String(member.userId) !== String(this.userId)) {
        this._signal(member.userId, { type: 'bye' }).catch(() => {});
      }
    }
    this._closeAllPeers();
    if (this.localStream) {
      this.localStream.getTracks().forEach((track) => track.stop());
      this.localStream.release?.();
      this.localStream = null;
    }
    this.onLocalStream?.(null);
    this.members = [];
    this.remoteStreams.clear();
    this._emitState();
  }
}
