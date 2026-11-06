import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { roomsApi, mediaApi, chatApi } from '../api/endpoints';
import { addRecentRoom } from '../services/storage';
import { CHAT_PAGE_SIZE } from '../config';
import { shouldApplyState } from '../sync/PlaybackSync';
import { VoiceEngine } from '../voice/VoiceEngine';
import { useAuth } from './AuthContext';
import { useSocket } from './SocketContext';

const RoomContext = createContext(null);

const EMPTY_VOICE = {
  active: false,
  canPublish: false,
  publishing: false,
  localStream: null,
  peerCount: 0,
  connectedPeers: 0,
  remoteSpeakerIds: [],
  status: 'idle',
};

const initialState = {
  room: null,
  membership: null,
  members: [],
  onlineUserIds: [],
  playback: null,
  media: [],
  messages: [],
  hostMessages: [],
  messagePaging: {
    room: { hasMore: false, nextBefore: null, loading: false },
    host: { hasMore: false, nextBefore: null, loading: false },
  },
  speakRequests: [],
  joinRequests: [],
  loading: false,
  activating: false,
  joined: false,
  error: null,
  evicted: null,
  pending: null,
  notice: null,
  micEnabled: false,
  voice: EMPTY_VOICE,
  remoteStreams: [],
  voiceError: null,
};

function uniqueMessages(existing, incoming) {
  const seen = new Set(existing.map((message) => message.id));
  const additions = (Array.isArray(incoming) ? incoming : [incoming]).filter(
    (message) => message && !seen.has(message.id),
  );
  if (!additions.length) return existing;
  return [...existing, ...additions].sort(
    (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
  );
}

function mergeMembers(existing, incoming) {
  const map = new Map(existing.map((member) => [String(member.userId), member]));
  (Array.isArray(incoming) ? incoming : [incoming]).forEach((member) => {
    if (member) map.set(String(member.userId), { ...map.get(String(member.userId)), ...member });
  });
  return [...map.values()].sort((a, b) => {
    if (a.role === b.role) return new Date(a.joinedAt || 0) - new Date(b.joinedAt || 0);
    return a.role === 'host' ? -1 : 1;
  });
}

function normalizeOnlineUsers(list = []) {
  return [...new Set((list || []).map((item) => String(item)))];
}

function friendlyError(error) {
  if (error?.code === 'NOT_CONNECTED') {
    return 'You are offline. Reconnect to control this online room.';
  }
  return error?.message || 'Something went wrong. Try again.';
}

export function RoomProvider({ children }) {
  const { user } = useAuth();
  const { socket, emitAck, connected, serverNow } = useSocket();
  const [state, setState] = useState(initialState);
  const stateRef = useRef(initialState);
  const voiceRef = useRef(null);
  const remoteStreamsRef = useRef(new Map());
  const socketRef = useRef(socket);
  const userRef = useRef(user);
  const joinedRef = useRef(false);
  const rejoinInFlight = useRef(false);

  const update = useCallback((patch) => {
    setState((current) => {
      const next = typeof patch === 'function' ? patch(current) : { ...current, ...patch };
      stateRef.current = next;
      return next;
    });
  }, []);

  useEffect(() => {
    socketRef.current = socket;
  }, [socket]);

  useEffect(() => {
    userRef.current = user;
    if (!user) {
      joinedRef.current = false;
      if (voiceRef.current) {
        voiceRef.current.stop().catch(() => {});
        voiceRef.current = null;
      }
      remoteStreamsRef.current.clear();
      setState(initialState);
      stateRef.current = initialState;
    }
  }, [user]);

  const applyPlayback = useCallback(
    (playback) => {
      if (!playback) return;
      update((current) => {
        if (!current.room) return current;
        if (!shouldApplyState(current.playback?.sequence, playback.sequence)) return current;
        let media = current.media;
        if (playback.media?.id && !media.some((item) => item.id === playback.media.id)) {
          media = [playback.media, ...media];
        }
        return { ...current, playback, media };
      });
    },
    [update],
  );

  const stopVoice = useCallback(async () => {
    if (voiceRef.current) {
      await voiceRef.current.stop().catch(() => {});
      voiceRef.current = null;
    }
    remoteStreamsRef.current.clear();
    update({
      voice: EMPTY_VOICE,
      remoteStreams: [],
      micEnabled: false,
    });
  }, [update]);

  const createVoiceEngine = useCallback(
    (room, members) => {
      if (!user) return null;
      if (voiceRef.current) {
        voiceRef.current.updateMembers(members);
        return voiceRef.current;
      }
      const engine = new VoiceEngine({
        socket: socketRef.current,
        emitAck,
        roomId: room.roomId,
        userId: user.id,
        onRemoteStream: (userId, stream) => {
          if (stream) remoteStreamsRef.current.set(String(userId), stream);
          else remoteStreamsRef.current.delete(String(userId));
          update({ remoteStreams: [...remoteStreamsRef.current.entries()] });
        },
        onState: (voice) => update({ voice }),
        onLocalStream: (stream) => {
          update({ voice: { ...stateRef.current.voice, localStream: stream } });
        },
        onError: (error) => {
          update({ voiceError: { id: Date.now(), message: error.message || 'Voice connection failed' } });
        },
      });
      voiceRef.current = engine;
      engine.start(members).catch(() => {});
      return engine;
    },
    [emitAck, update, user],
  );

  const activate = useCallback(
    async (roomPayload, membershipPayload) => {
      if (!user) throw new Error('Sign in to join a room');
      const room = roomPayload;
      const membership = membershipPayload;
      if (!membership || membership.status !== 'active') {
        throw new Error('Your membership is not active yet');
      }
      update({
        loading: true,
        activating: true,
        error: null,
        room,
        membership,
        pending: null,
        joined: false,
        evicted: null,
      });
      try {
        const [mediaResult, membersResult, playbackResult] = await Promise.allSettled([
          mediaApi.list(room.roomId),
          roomsApi.members(room.roomId),
          roomsApi.playback(room.roomId),
        ]);
        const messagesResult = await chatApi
          .list(room.roomId, { channel: 'room', limit: CHAT_PAGE_SIZE })
          .catch(() => ({ data: [], hasMore: false, nextBefore: null }));
        const hostResult = membership.permissions?.canChat
          ? await chatApi
              .list(room.roomId, { channel: 'host', limit: CHAT_PAGE_SIZE })
              .catch(() => ({ data: [], hasMore: false, nextBefore: null }))
          : { data: [], hasMore: false, nextBefore: null };
        let speakRequests = [];
        let joinRequests = [];
        if (membership.role === 'host') {
          const [speak, joins] = await Promise.allSettled([
            roomsApi.speakRequests(room.roomId),
            roomsApi.joinRequests(room.roomId),
          ]);
          if (speak.status === 'fulfilled') speakRequests = speak.value;
          if (joins.status === 'fulfilled') joinRequests = joins.value;
        }

        const members = membersResult.status === 'fulfilled' ? membersResult.value : [membership];
        update((current) => ({
          ...current,
          room,
          membership,
          members,
          onlineUserIds: normalizeOnlineUsers([...current.onlineUserIds, user.id]),
          media: mediaResult.status === 'fulfilled' ? mediaResult.value : [],
          playback: playbackResult.status === 'fulfilled' ? playbackResult.value : room.playback,
          messages: messagesResult.data || [],
          hostMessages: hostResult.data || [],
          messagePaging: {
            room: {
              hasMore: Boolean(messagesResult.hasMore),
              nextBefore: messagesResult.nextBefore || null,
              loading: false,
            },
            host: {
              hasMore: Boolean(hostResult.hasMore),
              nextBefore: hostResult.nextBefore || null,
              loading: false,
            },
          },
          speakRequests,
          joinRequests,
          loading: false,
          activating: false,
          joined: true,
        }));
        joinedRef.current = true;
        await addRecentRoom({ ...room, role: membership.role }).catch(() => {});

        const engine = createVoiceEngine(room, members);
        if (engine) engine.updateMembers(members);

        const activeSocket = socketRef.current;
        if (activeSocket?.connected) {
          try {
            const response = await emitAck('room:join', { roomId: room.roomId });
            update((current) => ({
              ...current,
              playback: response.playback || current.playback,
              members: response.members?.length ? response.members : current.members,
              membership: response.membership || current.membership,
              onlineUserIds: normalizeOnlineUsers(response.onlineUsers || current.onlineUserIds),
              joined: true,
            }));
            if (voiceRef.current && response.members) voiceRef.current.updateMembers(response.members);
          } catch (error) {
            if (['NOT_A_MEMBER', 'ROOM_ENDED'].includes(error.code)) {
              update({ evicted: { reason: error.code } });
            }
          }
        }
        return { room, membership };
      } catch (error) {
        update({ loading: false, activating: false, error: friendlyError(error) });
        throw error;
      }
    },
    [createVoiceEngine, emitAck, update, user],
  );

  const enterRoom = useCallback(
    async (roomCode, { password, message, join = true } = {}) => {
      const code = String(roomCode || '').trim().toUpperCase();
      if (!code) throw new Error('Enter a room code');
      update({ loading: true, error: null, evicted: null });
      try {
        let details = null;
        try {
          details = await roomsApi.get(code);
        } catch (error) {
          if (error?.response?.status !== 403 || error?.response?.data?.error?.code !== 'PRIVATE_ROOM') {
            throw error;
          }
          if (!join) throw error;
        }

        if (details?.membership?.status === 'active') {
          return await activate(details.room, details.membership);
        }
        if (details?.membership?.status === 'pending') {
          update({
            loading: false,
            pending: { room: details.room, membership: details.membership },
            room: details.room,
          });
          return { state: 'pending', room: details.room, membership: details.membership };
        }
        if (!join) {
          const error = new Error('Join this room to see the live session');
          error.code = 'NEED_JOIN';
          error.room = details?.room;
          throw error;
        }

        const joined = await roomsApi.join(code, { password, message });
        if (joined.state === 'pending' || joined.membership?.status === 'pending') {
          update({
            loading: false,
            pending: { room: joined.room, membership: joined.membership },
            room: joined.room,
          });
          return { state: 'pending', room: joined.room, membership: joined.membership };
        }
        return await activate(joined.room, joined.membership);
      } catch (error) {
        update({
          loading: false,
          error: friendlyError(error),
        });
        error.friendlyMessage = friendlyError(error);
        throw error;
      }
    },
    [activate, update],
  );

  const enterCreatedRoom = useCallback(
    async (payload) => {
      if (!payload?.room || !payload?.membership) throw new Error('Room creation returned no membership');
      return activate(payload.room, payload.membership);
    },
    [activate],
  );

  const clearRoom = useCallback(() => {
    joinedRef.current = false;
    if (voiceRef.current) {
      voiceRef.current.stop().catch(() => {});
      voiceRef.current = null;
    }
    remoteStreamsRef.current.clear();
    update(initialState);
  }, [update]);

  const leaveRoom = useCallback(async () => {
    const current = stateRef.current;
    if (!current.room) return;
    const activeSocket = socketRef.current;
    if (current.membership?.role !== 'host') {
      if (activeSocket?.connected) {
        activeSocket.emit('room:leave', { roomId: current.room.roomId }, () => {});
      }
      await roomsApi.leave(current.room.roomId).catch(() => {});
    }
    joinedRef.current = false;
    await stopVoice();
    clearRoom();
  }, [clearRoom, stopVoice]);

  const refreshRoom = useCallback(async () => {
    const current = stateRef.current;
    if (!current.room) return;
    const [details, members] = await Promise.all([
      roomsApi.get(current.room.roomId),
      roomsApi.members(current.room.roomId),
    ]);
    update({
      room: details.room,
      membership: details.membership || current.membership,
      members,
    });
    if (voiceRef.current) voiceRef.current.updateMembers(members);
    return details;
  }, [update]);

  const refreshSpeakRequests = useCallback(async () => {
    const current = stateRef.current;
    if (!current.room || current.membership?.role !== 'host') return;
    const requests = await roomsApi.speakRequests(current.room.roomId);
    update({ speakRequests: requests });
  }, [update]);

  const refreshJoinRequests = useCallback(async () => {
    const current = stateRef.current;
    if (!current.room || current.membership?.role !== 'host') return;
    const requests = await roomsApi.joinRequests(current.room.roomId);
    update({ joinRequests: requests });
  }, [update]);

  const onlineSocket = useCallback(async (event, payload, restFallback) => {
    const activeSocket = socketRef.current;
    if (activeSocket?.connected) {
      try {
        return await emitAck(event, payload);
      } catch (error) {
        if (error.code !== 'NOT_CONNECTED' && error.code !== 'REALTIME_TIMEOUT') throw error;
      }
    }
    if (restFallback) return restFallback();
    const error = new Error('The live service is unavailable');
    error.code = 'NOT_CONNECTED';
    throw error;
  }, [emitAck]);

  const hostCommand = useCallback(
    async (action, extras = {}) => {
      const current = stateRef.current;
      if (!current.room) throw new Error('No active room');
      const payload = { roomId: current.room.roomId, action, ...extras };
      const response = await onlineSocket('playback:command', payload, () =>
        roomsApi.playbackCommand(current.room.roomId, { action, ...extras }).then((playback) => ({
          playback,
        })),
      );
      if (response?.playback) applyPlayback(response.playback);
      return response?.playback;
    },
    [applyPlayback, onlineSocket],
  );

  const reportHostPosition = useCallback(
    async (positionMs) => {
      const current = stateRef.current;
      if (!current.room || current.membership?.role !== 'host') return;
      if (current.playback?.status !== 'playing') return;
      const activeSocket = socketRef.current;
      if (!activeSocket?.connected) return;
      try {
        const response = await emitAck(
          'playback:heartbeat',
          { roomId: current.room.roomId, positionMs: Math.max(0, Math.round(positionMs)) },
          8000,
        );
        if (response?.playback) applyPlayback(response.playback);
      } catch {
        // Directional heartbeats are best effort; REST control still works.
      }
    },
    [applyPlayback, emitAck],
  );

  const requestSync = useCallback(async () => {
    const current = stateRef.current;
    if (!current.room) return;
    try {
      const response = await onlineSocket('playback:sync', { roomId: current.room.roomId }, () =>
        roomsApi.playback(current.room.roomId).then((playback) => ({ playback })),
      );
      if (response?.playback) applyPlayback(response.playback);
    } catch {
      // A later reconnect will resync.
    }
  }, [applyPlayback, onlineSocket]);

  const sendMessage = useCallback(
    async ({ channel = 'room', body, targetUserId }) => {
      const current = stateRef.current;
      if (!current.room) throw new Error('No active room');
      const text = String(body || '').trim();
      if (!text) throw new Error('Message cannot be empty');
      const payload = { roomId: current.room.roomId, channel, body: text };
      if (targetUserId) payload.targetUserId = targetUserId;
      const response = await onlineSocket('chat:send', payload, () =>
        chatApi.send(current.room.roomId, payload).then((message) => ({ message })),
      );
      if (response?.message) {
        if (channel === 'host') {
          update((existing) => ({
            ...existing,
            hostMessages: uniqueMessages(existing.hostMessages, response.message),
          }));
        } else {
          update((existing) => ({
            ...existing,
            messages: uniqueMessages(existing.messages, response.message),
          }));
        }
      }
      return response?.message;
    },
    [onlineSocket, update],
  );

  const loadMoreMessages = useCallback(
    async (channel = 'room') => {
      const current = stateRef.current;
      if (!current.room) return;
      const paging = current.messagePaging[channel];
      if (!paging?.hasMore || paging.loading) return;
      update((existing) => ({
        ...existing,
        messagePaging: {
          ...existing.messagePaging,
          [channel]: { ...existing.messagePaging[channel], loading: true },
        },
      }));
      try {
        const result = await chatApi.list(current.room.roomId, {
          channel,
          before: paging.nextBefore,
          limit: CHAT_PAGE_SIZE,
        });
        update((existing) => {
          const key = channel === 'host' ? 'hostMessages' : 'messages';
          return {
            ...existing,
            [key]: uniqueMessages(result.data || [], existing[key]),
            messagePaging: {
              ...existing.messagePaging,
              [channel]: {
                hasMore: Boolean(result.hasMore),
                nextBefore: result.nextBefore || null,
                loading: false,
              },
            },
          };
        });
      } catch (error) {
        update((existing) => ({
          ...existing,
          messagePaging: {
            ...existing.messagePaging,
            [channel]: { ...existing.messagePaging[channel], loading: false },
          },
        }));
        throw error;
      }
    },
    [update],
  );

  const deleteMessage = useCallback(
    async (message, channel = 'room') => {
      const current = stateRef.current;
      if (!current.room) return;
      await onlineSocket(
        'chat:delete',
        { roomId: current.room.roomId, messageId: message.id },
        () => chatApi.remove(current.room.roomId, message.id),
      );
      update((existing) => ({
        ...existing,
        messages: existing.messages.map((item) =>
          item.id === message.id ? { ...item, deleted: true, body: '' } : item,
        ),
        hostMessages: existing.hostMessages.map((item) =>
          item.id === message.id ? { ...item, deleted: true, body: '' } : item,
        ),
      }));
    },
    [onlineSocket, update],
  );

  const clearChat = useCallback(async () => {
    const current = stateRef.current;
    if (!current.room) return;
    await chatApi.clear(current.room.roomId);
    update({ messages: [] });
  }, [update]);

  const requestSpeak = useCallback(
    async (note = '') => {
      const current = stateRef.current;
      if (!current.room) throw new Error('No active room');
      const response = await onlineSocket(
        'speak:request',
        { roomId: current.room.roomId, note },
        () => roomsApi.requestSpeak(current.room.roomId, note),
      );
      return response;
    },
    [onlineSocket],
  );

  const decideSpeak = useCallback(
    async (requestId, decision) => {
      const current = stateRef.current;
      if (!current.room) return;
      await onlineSocket(
        'speak:decision',
        { roomId: current.room.roomId, requestId, decision },
        () => roomsApi.decideSpeak(current.room.roomId, requestId, decision),
      );
      update((existing) => ({
        ...existing,
        speakRequests: existing.speakRequests.filter((item) => item.id !== requestId),
      }));
    },
    [onlineSocket, update],
  );

  const setMemberPermissions = useCallback(
    async (memberId, permissions) => {
      const current = stateRef.current;
      if (!current.room) return;
      const updated = await roomsApi.setMemberPermissions(
        current.room.roomId,
        memberId,
        permissions,
      );
      update((existing) => ({ ...existing, members: mergeMembers(existing.members, updated) }));
      return updated;
    },
    [update],
  );

  const setMemberMic = useCallback(
    async (userId, granted) => {
      const current = stateRef.current;
      if (!current.room) return;
      const response = await onlineSocket(
        'mic:set',
        { roomId: current.room.roomId, userId, granted },
        () => roomsApi.grantMic(current.room.roomId, userId, granted),
      );
      if (response?.member) {
        update((existing) => ({ ...existing, members: mergeMembers(existing.members, response.member) }));
      }
      await refreshRoom().catch(() => {});
      return response;
    },
    [onlineSocket, refreshRoom, update],
  );

  const muteAll = useCallback(async () => {
    const current = stateRef.current;
    if (!current.room) return;
    const response = await onlineSocket(
      'mic:mute-all',
      { roomId: current.room.roomId },
      () => roomsApi.muteAll(current.room.roomId),
    );
    update((existing) => ({
      ...existing,
      members: existing.members.map((member) =>
        member.role === 'participant'
          ? {
              ...member,
              permissions: {
                ...member.permissions,
                canSpeak: false,
                micApproved: false,
                micRequested: false,
                mutedByHost: true,
              },
            }
          : member,
      ),
      speakRequests: [],
    }));
    return response;
  }, [onlineSocket, update]);

  const removeMember = useCallback(
    async (memberId, ban = false) => {
      const current = stateRef.current;
      if (!current.room) return;
      await roomsApi.removeMember(current.room.roomId, memberId, ban);
      update((existing) => ({
        ...existing,
        members: existing.members.filter((member) => member.id !== memberId),
      }));
    },
    [update],
  );

  const decideJoin = useCallback(
    async (memberId, decision, ban = false) => {
      const current = stateRef.current;
      if (!current.room) return;
      await roomsApi.decideJoinRequest(current.room.roomId, memberId, decision, ban);
      update((existing) => ({
        ...existing,
        joinRequests: existing.joinRequests.filter((item) => item.id !== memberId),
      }));
    },
    [update],
  );

  const updateSettings = useCallback(
    async (settings) => {
      const current = stateRef.current;
      if (!current.room) return;
      const room = await roomsApi.updateSettings(current.room.roomId, settings);
      update({ room: { ...current.room, ...room } });
      return room;
    },
    [update],
  );

  const endRoom = useCallback(async () => {
    const current = stateRef.current;
    if (!current.room) return;
    const room = await roomsApi.end(current.room.roomId);
    joinedRef.current = false;
    await stopVoice();
    update({
      room: { ...current.room, ...room },
      playback: current.playback ? { ...current.playback, status: 'ended' } : current.playback,
      joined: false,
    });
  }, [stopVoice, update]);

  const addUrlMedia = useCallback(
    async (payload) => {
      const current = stateRef.current;
      if (!current.room) throw new Error('No active room');
      const media = await mediaApi.addUrl(current.room.roomId, payload);
      update((existing) => ({
        ...existing,
        media: [media, ...existing.media.filter((item) => item.id !== media.id)],
      }));
      return media;
    },
    [update],
  );

  const uploadMedia = useCallback(
    async (file, fields = {}) => {
      const current = stateRef.current;
      if (!current.room) throw new Error('No active room');
      const media = await mediaApi.upload(current.room.roomId, file, fields);
      update((existing) => ({
        ...existing,
        media: [media, ...existing.media.filter((item) => item.id !== media.id)],
      }));
      return media;
    },
    [update],
  );

  const removeMedia = useCallback(
    async (mediaId) => {
      const current = stateRef.current;
      if (!current.room) return;
      await mediaApi.remove(current.room.roomId, mediaId);
      update((existing) => ({
        ...existing,
        media: existing.media.filter((item) => item.id !== mediaId),
      }));
    },
    [update],
  );

  const selectMedia = useCallback(
    async (mediaId) => {
      const playback = await hostCommand('setMedia', { mediaId });
      return playback;
    },
    [hostCommand],
  );

  const enableMic = useCallback(async () => {
    const current = stateRef.current;
    if (!current.membership?.permissions?.canSpeak || current.membership?.permissions?.mutedByHost) {
      throw new Error('The host has not granted microphone access');
    }
    if (!voiceRef.current) {
      if (!current.room) throw new Error('No active room');
      createVoiceEngine(current.room, current.members);
    }
    if (!voiceRef.current) throw new Error('Voice engine is unavailable');
    await voiceRef.current.enableMic();
    update({ micEnabled: Boolean(voiceRef.current?.localStream) });
  }, [createVoiceEngine, update]);

  const disableMic = useCallback(async () => {
    if (voiceRef.current) await voiceRef.current.disableMic();
    update({ micEnabled: false });
  }, [update]);

  const toggleMic = useCallback(async () => {
    if (stateRef.current.micEnabled) return disableMic();
    return enableMic();
  }, [disableMic, enableMic]);

  useEffect(() => {
    if (!socket) return undefined;

    const inRoom = (payload) =>
      payload?.roomId &&
      stateRef.current.room &&
      String(payload.roomId).toUpperCase() === String(stateRef.current.room.roomId).toUpperCase();

    const onPlayback = (payload) => {
      if (inRoom(payload)) applyPlayback(payload.playback);
    };

    const onMemberJoined = (payload) => {
      if (!inRoom(payload) || !payload.member) return;
      update((current) => ({
        ...current,
        members: mergeMembers(current.members, payload.member),
      }));
      if (voiceRef.current) {
        voiceRef.current.updateMembers(
          mergeMembers(stateRef.current.members, payload.member),
        );
      }
    };

    const onMemberUpdated = (payload) => {
      if (!inRoom(payload) || !payload.member) return;
      const isSelf = String(payload.member.userId) === String(userRef.current?.id);
      update((current) => ({
        ...current,
        members: mergeMembers(current.members, payload.member),
        membership:
          isSelf && current.membership
            ? {
                ...current.membership,
                permissions: payload.member.permissions,
                role: payload.member.role || current.membership.role,
              }
            : current.membership,
      }));
      if (voiceRef.current) {
        voiceRef.current.updateMembers(
          mergeMembers(stateRef.current.members, payload.member),
        );
        if (
          isSelf &&
          (!payload.member.permissions?.canSpeak || payload.member.permissions?.mutedByHost) &&
          voiceRef.current.canPublish
        ) {
          voiceRef.current.disableMic();
          update({ micEnabled: false });
        }
      }
    };

    const onMemberLeft = (payload) => {
      if (!inRoom(payload)) return;
      update((current) => {
        const members = current.members.filter(
          (member) =>
            String(member.userId) !== String(payload.userId) &&
            String(member.id) !== String(payload.memberId),
        );
        if (voiceRef.current) voiceRef.current.updateMembers(members);
        return {
          ...current,
          members,
          onlineUserIds: current.onlineUserIds.filter(
            (id) => String(id) !== String(payload.userId),
          ),
          ...(payload.reason && payload.reason !== 'left'
            ? { notice: { id: Date.now(), message: 'A participant was removed.', tone: 'default' } }
            : {}),
        };
      });
    };

    const onPermissionUpdated = (payload) => {
      if (!inRoom(payload)) return;
      const isSelf = String(payload.userId || userRef.current?.id) === String(userRef.current?.id);
      if (!isSelf) return;
      update((current) => ({
        ...current,
        membership: current.membership
          ? {
              ...current.membership,
              permissions: payload.permissions,
              role: payload.role || current.membership.role,
            }
          : current.membership,
      }));
    };

    const onPresence = (payload) => {
      if (!inRoom(payload)) return;
      update((current) => {
        const set = new Set(current.onlineUserIds.map(String));
        if (payload.online) set.add(String(payload.userId));
        else set.delete(String(payload.userId));
        return { ...current, onlineUserIds: [...set] };
      });
    };

    const onChatMessage = (payload) => {
      if (!inRoom(payload) || !payload.message) return;
      const message = payload.message;
      if (message.channel === 'host') {
        const selfId = String(userRef.current?.id);
        const isHost = stateRef.current.membership?.role === 'host';
        const related =
          isHost || String(message.senderId) === selfId || String(message.recipientId) === selfId;
        if (!related) return;
        update((current) => ({
          ...current,
          hostMessages: uniqueMessages(current.hostMessages, message),
        }));
      } else {
        update((current) => ({ ...current, messages: uniqueMessages(current.messages, message) }));
      }
    };

    const onChatDeleted = (payload) => {
      if (!inRoom(payload)) return;
      update((current) => ({
        ...current,
        messages: current.messages.map((message) =>
          message.id === payload.messageId ? { ...message, deleted: true, body: '' } : message,
        ),
        hostMessages: current.hostMessages.map((message) =>
          message.id === payload.messageId ? { ...message, deleted: true, body: '' } : message,
        ),
      }));
    };

    const onChatCleared = (payload) => {
      if (inRoom(payload)) update({ messages: [] });
    };

    const onSpeakRequest = (payload) => {
      if (!inRoom(payload) || !payload.request) return;
      update((current) => ({
        ...current,
        speakRequests: [
          ...current.speakRequests.filter((item) => item.id !== payload.request.id),
          payload.request,
        ],
        notice: { id: Date.now(), message: 'New microphone request', tone: 'default' },
      }));
    };

    const onSpeakResolved = (payload) => {
      if (!inRoom(payload)) return;
      update((current) => ({
        ...current,
        speakRequests: current.speakRequests.filter(
          (item) => item.id !== payload.requestId,
        ),
      }));
    };

    const onSpeakDecision = (payload) => {
      if (!inRoom(payload)) return;
      if (
        String(payload.notification?.userId || '') === String(userRef.current?.id) ||
        payload.decision
      ) {
        update({
          notice: {
            id: Date.now(),
            message:
              payload.decision === 'approve'
                ? 'The host approved your microphone. Tap the mic to speak.'
                : 'The host declined your microphone request.',
            tone: payload.decision === 'approve' ? 'success' : 'default',
          },
        });
      }
    };

    const onMuteAll = (payload) => {
      if (!inRoom(payload)) return;
      if (voiceRef.current?.canPublish) voiceRef.current.disableMic();
      update((current) => ({
        ...current,
        micEnabled: false,
        members: current.members.map((member) =>
          member.role === 'host'
            ? member
            : {
                ...member,
                permissions: {
                  ...member.permissions,
                  canSpeak: false,
                  micApproved: false,
                  micRequested: false,
                  mutedByHost: true,
                },
              },
        ),
        membership:
          current.membership?.role === 'host'
            ? current.membership
            : {
                ...current.membership,
                permissions: {
                  ...current.membership?.permissions,
                  canSpeak: false,
                  micApproved: false,
                  micRequested: false,
                  mutedByHost: true,
                },
              },
        notice: { id: Date.now(), message: 'The host muted all microphones.', tone: 'default' },
      }));
    };

    const onMicRevoked = (payload) => {
      if (!inRoom(payload)) return;
      if (voiceRef.current?.canPublish) voiceRef.current.disableMic();
      update({
        micEnabled: false,
        notice: { id: Date.now(), message: 'Your microphone was revoked by the host.', tone: 'default' },
      });
    };

    const onJoinRequest = (payload) => {
      if (!inRoom(payload) || !payload.member) return;
      update((current) => ({
        ...current,
        joinRequests: [
          ...current.joinRequests.filter((item) => item.id !== payload.member.id),
          payload.member,
        ],
        notice: { id: Date.now(), message: `${payload.member.user?.name || 'Someone'} wants to join.`, tone: 'default' },
      }));
    };

    const onJoinResolved = (payload) => {
      if (!inRoom(payload)) return;
      update((current) => ({
        ...current,
        joinRequests: current.joinRequests.filter((item) => item.id !== payload.memberId),
      }));
    };

    const onRoomSettings = (payload) => {
      if (!inRoom(payload) || !payload.room) return;
      update({ room: payload.room });
    };

    const onEnded = (payload) => {
      if (!inRoom(payload)) return;
      joinedRef.current = false;
      if (voiceRef.current) voiceRef.current.stop().catch(() => {});
      update((current) => ({
        ...current,
        joined: false,
        playback: current.playback ? { ...current.playback, status: 'ended' } : current.playback,
        room: current.room ? { ...current.room, status: 'ended' } : current.room,
        notice: { id: Date.now(), message: 'The host ended this session.', tone: 'default' },
      }));
    };

    const onAccessRevoked = (payload) => {
      if (!inRoom(payload)) return;
      joinedRef.current = false;
      if (voiceRef.current) voiceRef.current.stop().catch(() => {});
      update({ evicted: { reason: payload.reason || 'removed' }, joined: false });
    };

    const onMediaAdded = (payload) => {
      if (!inRoom(payload) || !payload.media) return;
      update((current) => ({
        ...current,
        media: [payload.media, ...current.media.filter((item) => item.id !== payload.media.id)],
      }));
    };

    const onMediaRemoved = (payload) => {
      if (!inRoom(payload)) return;
      update((current) => ({
        ...current,
        media: current.media.filter((item) => item.id !== payload.mediaId),
      }));
    };

    const onSignal = (payload) => {
      if (!inRoom(payload)) return;
      if (voiceRef.current) voiceRef.current.receiveSignal(payload);
    };

    const onReconnect = async () => {
      const current = stateRef.current;
      if (!current.room || !joinedRef.current || rejoinInFlight.current) return;
      rejoinInFlight.current = true;
      try {
        const response = await emitAck('room:join', { roomId: current.room.roomId });
        update((existing) => ({
          ...existing,
          playback: response.playback || existing.playback,
          members: response.members?.length ? response.members : existing.members,
          membership: response.membership || existing.membership,
          onlineUserIds: normalizeOnlineUsers(response.onlineUsers || existing.onlineUserIds),
        }));
        if (voiceRef.current) voiceRef.current.updateMembers(response.members || []);
      } catch {
        // A deliberate removal is surfaced by room:removed.
      } finally {
        rejoinInFlight.current = false;
      }
    };

    socket.on('playback:state', onPlayback);
    socket.on('room:member-joined', onMemberJoined);
    socket.on('member:updated', onMemberUpdated);
    socket.on('permission:updated', onPermissionUpdated);
    socket.on('room:member-left', onMemberLeft);
    socket.on('presence:update', onPresence);
    socket.on('chat:message', onChatMessage);
    socket.on('chat:deleted', onChatDeleted);
    socket.on('chat:cleared', onChatCleared);
    socket.on('speak:request', onSpeakRequest);
    socket.on('speak:request:resolved', onSpeakResolved);
    socket.on('speak:decision', onSpeakDecision);
    socket.on('speak:mute-all', onMuteAll);
    socket.on('mic:revoked', onMicRevoked);
    socket.on('join:request', onJoinRequest);
    socket.on('join:request:resolved', onJoinResolved);
    socket.on('room:settings', onRoomSettings);
    socket.on('room:ended', onEnded);
    socket.on('room:removed', onAccessRevoked);
    socket.on('room:access-revoked', onAccessRevoked);
    socket.on('media:added', onMediaAdded);
    socket.on('media:removed', onMediaRemoved);
    socket.on('webrtc:signal', onSignal);
    socket.on('connect', onReconnect);

    if (socket.connected && joinedRef.current) onReconnect();

    return () => {
      socket.off('playback:state', onPlayback);
      socket.off('room:member-joined', onMemberJoined);
      socket.off('member:updated', onMemberUpdated);
      socket.off('permission:updated', onPermissionUpdated);
      socket.off('room:member-left', onMemberLeft);
      socket.off('presence:update', onPresence);
      socket.off('chat:message', onChatMessage);
      socket.off('chat:deleted', onChatDeleted);
      socket.off('chat:cleared', onChatCleared);
      socket.off('speak:request', onSpeakRequest);
      socket.off('speak:request:resolved', onSpeakResolved);
      socket.off('speak:decision', onSpeakDecision);
      socket.off('speak:mute-all', onMuteAll);
      socket.off('mic:revoked', onMicRevoked);
      socket.off('join:request', onJoinRequest);
      socket.off('join:request:resolved', onJoinResolved);
      socket.off('room:settings', onRoomSettings);
      socket.off('room:ended', onEnded);
      socket.off('room:removed', onAccessRevoked);
      socket.off('room:access-revoked', onAccessRevoked);
      socket.off('media:added', onMediaAdded);
      socket.off('media:removed', onMediaRemoved);
      socket.off('webrtc:signal', onSignal);
      socket.off('connect', onReconnect);
    };
  }, [applyPlayback, emitAck, socket, update]);

  useEffect(
    () => () => {
      if (voiceRef.current) voiceRef.current.stop().catch(() => {});
    },
    [],
  );

  const value = useMemo(() => {
    const isHost = state.membership?.role === 'host';
    const canSpeak = Boolean(
      state.membership?.permissions?.canSpeak && !state.membership?.permissions?.mutedByHost,
    );
    const isOnline = state.onlineUserIds.map(String).includes(String(user?.id));
    return {
      ...state,
      isHost,
      canSpeak,
      isOnline,
      connected,
      serverNow,
      me: user,
      enterRoom,
      enterCreatedRoom,
      leaveRoom,
      clearRoom,
      refreshRoom,
      refreshSpeakRequests,
      refreshJoinRequests,
      hostCommand,
      reportHostPosition,
      requestSync,
      sendMessage,
      loadMoreMessages,
      deleteMessage,
      clearChat,
      requestSpeak,
      decideSpeak,
      setMemberPermissions,
      setMemberMic,
      muteAll,
      removeMember,
      decideJoin,
      updateSettings,
      endRoom,
      addUrlMedia,
      uploadMedia,
      removeMedia,
      selectMedia,
      enableMic,
      disableMic,
      toggleMic,
      clearNotice: () => update({ notice: null }),
      clearVoiceError: () => update({ voiceError: null }),
    };
  }, [
    state,
    connected,
    serverNow,
    user,
    enterRoom,
    enterCreatedRoom,
    leaveRoom,
    clearRoom,
    refreshRoom,
    refreshSpeakRequests,
    refreshJoinRequests,
    hostCommand,
    reportHostPosition,
    requestSync,
    sendMessage,
    loadMoreMessages,
    deleteMessage,
    clearChat,
    requestSpeak,
    decideSpeak,
    setMemberPermissions,
    setMemberMic,
    muteAll,
    removeMember,
    decideJoin,
    updateSettings,
    endRoom,
    addUrlMedia,
    uploadMedia,
    removeMedia,
    selectMedia,
    enableMic,
    disableMic,
    toggleMic,
    update,
  ]);

  return <RoomContext.Provider value={value}>{children}</RoomContext.Provider>;
}

export function useRoom() {
  const value = useContext(RoomContext);
  if (!value) throw new Error('useRoom must be used inside RoomProvider');
  return value;
}
