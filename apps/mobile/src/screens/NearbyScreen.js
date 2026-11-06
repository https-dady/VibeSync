import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  ActivityIndicator,
  Alert,
  Pressable,
  Share,
  StyleSheet,
  TextInput,
  View,
} from 'react-native';
import Slider from '@react-native-community/slider';
import Video from 'react-native-video';
import {
  errorCodes,
  isErrorWithCode,
  pick,
  types,
} from '@react-native-documents/picker';
import { useFocusEffect } from '@react-navigation/native';
import { colors, radius, spacing, typography } from '../theme';
import Screen from '../components/Screen';
import AppText from '../components/AppText';
import Avatar from '../components/Avatar';
import Badge from '../components/Badge';
import Button from '../components/Button';
import Card from '../components/Card';
import Icon, { Dot, Waveform } from '../components/Icon';
import Input from '../components/Input';
import SegmentedControl from '../components/SegmentedControl';
import { useToast } from '../components/Toast';
import { useAuth } from '../context/AuthContext';
import { useRoom } from '../context/RoomContext';
import {
  expectedNearbyPosition,
  fetchNearbySession,
  getCapabilities,
  getHostSession,
  joinNearbyRoom,
  leaveNearbyRoom,
  nearbyMediaUrl,
  normalizeNearbyAddress,
  sendHostMessage,
  sendNearbyMessage,
  startDiscovery,
  startHost,
  stopDiscovery,
  stopHost,
  subscribeHostState,
  subscribePeerFound,
  subscribePeerLost,
  subscribeScanState,
  updatePlayback,
} from '../services/nearby';
import { formatBytes, formatClockTime, formatDuration, readableFileName } from '../utils/format';

function inferMediaType(file) {
  const mime = String(file?.type || '').toLowerCase();
  if (mime.startsWith('audio/')) return 'audio';
  if (mime.startsWith('video/')) return 'video';
  const name = String(file?.name || file?.uri || '').toLowerCase();
  if (/\.(mp3|m4a|aac|wav|flac|ogg|opus)$/.test(name)) return 'audio';
  return 'video';
}

function guessMime(file, mediaType) {
  if (file?.type) return file.type;
  return mediaType === 'audio' ? 'audio/mpeg' : 'video/mp4';
}

function ConnectionRow({ icon, label, value, tone = 'default' }) {
  return (
    <View style={styles.connectionRow}>
      <Icon name={icon} size={15} color={tone === 'orange' ? colors.orange : colors.yellow} />
      <AppText variant="micro" color={colors.textMuted} style={styles.connectionLabel}>
        {label.toUpperCase()}
      </AppText>
      <AppText variant="caption" color={colors.offWhite} numberOfLines={1} style={styles.connectionValue}>
        {value}
      </AppText>
    </View>
  );
}

export default function NearbyScreen({ navigation, route }) {
  const { user } = useAuth();
  const { room, joined } = useRoom();
  const { showToast } = useToast();
  const hostConfig = route.params?.hostConfig || null;
  const preferredType = user?.settings?.preferredMediaType || 'video';

  const [capabilities, setCapabilities] = useState(null);
  const [setupTab, setSetupTab] = useState(hostConfig ? 'host' : 'join');
  const [role, setRole] = useState(null);
  const [session, setSession] = useState(null);
  const [connection, setConnection] = useState(null);
  const [hostMedia, setHostMedia] = useState(null);
  const [clockOffset, setClockOffset] = useState(0);
  const [hostName, setHostName] = useState(
    hostConfig?.name || `${user?.name?.split(' ')[0] || 'My'}’s nearby room`,
  );
  const [mediaFile, setMediaFile] = useState(null);
  const [starting, setStarting] = useState(false);
  const [setupError, setSetupError] = useState('');
  const [peers, setPeers] = useState([]);
  const [scanning, setScanning] = useState(false);
  const [scanError, setScanError] = useState('');
  const [joinTarget, setJoinTarget] = useState(null);
  const [joinName, setJoinName] = useState(user?.name || '');
  const [joining, setJoining] = useState(false);
  const [manualAddress, setManualAddress] = useState('');
  const [manualError, setManualError] = useState('');
  const [playerPaused, setPlayerPaused] = useState(true);
  const [positionMs, setPositionMs] = useState(0);
  const [durationMs, setDurationMs] = useState(0);
  const [sliding, setSliding] = useState(false);
  const [slideValue, setSlideValue] = useState(0);
  const [chatText, setChatText] = useState('');
  const [sending, setSending] = useState(false);
  const [notice, setNotice] = useState('');
  const [hostWarning, setHostWarning] = useState('');
  const [bleWarning, setBleWarning] = useState('');
  const [leaving, setLeaving] = useState(false);
  const playerRef = useRef(null);
  const roleRef = useRef(null);
  const guestRef = useRef(null);
  const heartbeatRef = useRef(0);
  const lastCorrectionRef = useRef(0);
  const guestPositionRef = useRef(0);
  const peersRef = useRef(new Map());
  const sessionRef = useRef(null);
  const hostRefreshRef = useRef(false);
  const guestRefreshRef = useRef(false);

  useEffect(() => {
    roleRef.current = role;
  }, [role]);
  useEffect(() => {
    guestRef.current = connection;
  }, [connection]);
  useEffect(() => {
    sessionRef.current = session;
  }, [session]);
  useEffect(() => {
    guestPositionRef.current = positionMs;
  }, [positionMs]);

  useEffect(() => {
    let mounted = true;
    getCapabilities().then((value) => {
      if (mounted) setCapabilities(value);
    });
    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    const offFound = subscribePeerFound((peer) => {
      if (!peer?.baseUrl) return;
      const next = {
        ...peer,
        id: peer.id || `${peer.baseUrl}-${peer.code || ''}`,
        baseUrl: peer.baseUrl || `http://${peer.address}:${peer.port}`,
        lastSeen: Date.now(),
      };
      peersRef.current.set(next.id, next);
      setPeers([...peersRef.current.values()]);
    });
    const offLost = subscribePeerLost((peer) => {
      if (!peer?.id) return;
      peersRef.current.delete(peer.id);
      setPeers([...peersRef.current.values()]);
    });
    const offState = subscribeScanState((state) => {
      setScanning(Boolean(state?.scanning));
      if (state?.error) setScanError(state.error);
    });
    const offHost = subscribeHostState((state) => {
      if (!state?.active) {
        setBleWarning('');
        return;
      }
      setBleWarning(state.error ? String(state.error) : '');
    });
    return () => {
      offFound();
      offLost();
      offState();
      offHost();
    };
  }, []);

  useEffect(() => {
    const timer = setInterval(() => {
      const cutoff = Date.now() - 15000;
      let changed = false;
      for (const [id, peer] of peersRef.current) {
        if ((peer.lastSeen || 0) < cutoff) {
          peersRef.current.delete(id);
          changed = true;
        }
      }
      if (changed) setPeers([...peersRef.current.values()]);
    }, 5000);
    return () => clearInterval(timer);
  }, []);

  useFocusEffect(
    useCallback(
      () => () => {
        stopDiscovery().catch(() => {});
      },
      [],
    ),
  );

  useEffect(
    () => () => {
      stopDiscovery().catch(() => {});
      if (roleRef.current === 'guest' && guestRef.current) {
        leaveNearbyRoom(guestRef.current.baseUrl, guestRef.current.token).catch(() => {});
      }
      if (roleRef.current === 'host') {
        stopHost().catch(() => {});
      }
    },
    [],
  );

  const refreshHost = useCallback(async () => {
    if (hostRefreshRef.current) return null;
    hostRefreshRef.current = true;
    try {
      const result = await getHostSession();
      if (result?.session) {
        setSession(result.session);
        setClockOffset(Number(result.serverNow || Date.now()) - Date.now());
      }
      return result;
    } catch (error) {
      setNotice(error?.message || 'Could not read the local session');
      return null;
    } finally {
      hostRefreshRef.current = false;
    }
  }, []);

  const refreshGuest = useCallback(async () => {
    const active = guestRef.current;
    if (!active || guestRefreshRef.current) return null;
    guestRefreshRef.current = true;
    try {
      const result = await fetchNearbySession(active.baseUrl, active.token);
      setSession(result.session);
      setClockOffset(result.offsetMs || 0);
      setNotice('');
      return result;
    } catch (error) {
      setNotice(error?.message || 'The nearby room is unreachable');
      return null;
    } finally {
      guestRefreshRef.current = false;
    }
  }, []);

  useEffect(() => {
    if (role === 'host') {
      const timer = setInterval(refreshHost, 1500);
      return () => clearInterval(timer);
    }
    if (role === 'guest') {
      const timer = setInterval(refreshGuest, 1100);
      return () => clearInterval(timer);
    }
    return undefined;
  }, [role, refreshGuest, refreshHost]);

  useEffect(() => {
    if (!session?.playback) return;
    const playback = session.playback;
    setPlayerPaused(playback.status !== 'playing');
    if (role === 'guest') {
      const expected = expectedNearbyPosition(playback, Date.now(), clockOffset);
      if (!sliding) setPositionMs(expected);
      if (
        playback.status === 'playing' &&
        Date.now() - lastCorrectionRef.current > 4000
      ) {
        const drift = Math.abs(guestPositionRef.current - expected);
        if (drift > 1000) {
          playerRef.current?.seekTo(expected / 1000);
          lastCorrectionRef.current = Date.now();
        }
      }
    } else if (playback.status !== 'playing') {
      setPositionMs(Number(playback.positionMs) || 0);
    }
    // Playback sync is intentionally keyed on the host's state revision.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.playback?.updatedAt, session?.playback?.status, session?.playback?.positionMs, role]);

  const pickMedia = async () => {
    try {
      const [file] = await pick({
        type: [types.audio, types.video],
        mode: 'import',
        allowMultiSelection: false,
      });
      if (!file?.uri) return;
      setMediaFile({
        uri: file.uri,
        name: file.name || 'Nearby media',
        type: file.type || '',
        size: file.size,
        mediaType: inferMediaType(file),
      });
      setSetupError('');
    } catch (caught) {
      if (isErrorWithCode(caught) && caught.code === errorCodes.OPERATION_CANCELED) return;
      showToast(caught?.message || 'Could not select that file', 'error');
    }
  };

  const beginHost = async () => {
    if (!capabilities?.supported) {
      setSetupError(
        capabilities?.reason ||
          'Nearby hosting requires the native VibeSync app build on Android or iOS.',
      );
      return;
    }
    if (hostName.trim().length < 2) {
      setSetupError('Give your nearby room a name.');
      return;
    }
    if (!mediaFile?.uri) {
      setSetupError('Choose an audio or video file to host.');
      return;
    }
    setStarting(true);
    setSetupError('');
    try {
      await stopDiscovery().catch(() => {});
      const result = await startHost({
        code: hostConfig?.roomCode || undefined,
        name: hostName.trim(),
        hostName: user?.name || 'Host',
        mediaPath: mediaFile.uri,
        mediaTitle: readableFileName(mediaFile.name) || 'Nearby media',
        mediaType: mediaFile.mediaType,
        mimeType: guessMime(mediaFile, mediaFile.mediaType),
      });
      if (!result?.session) throw new Error('The local session did not start');
      setRole('host');
      setSession(result.session);
      setHostMedia(mediaFile);
      setConnection({
        baseUrl: result.baseUrl,
        token: result.token,
        code: result.code,
        port: result.port,
      });
      setClockOffset(Number(result.serverNow || Date.now()) - Date.now());
      setPositionMs(0);
      setNotice('');
      setHostWarning(result.warning ? String(result.warning) : '');
      setBleWarning('');
      showToast('Nearby room is live on this device', 'success');
    } catch (caught) {
      setSetupError(caught?.message || 'Could not start the nearby room');
    } finally {
      setStarting(false);
    }
  };

  const scan = async () => {
    setScanError('');
    try {
      await startDiscovery(user?.name || '');
      setScanning(true);
    } catch (caught) {
      setScanError(
        caught?.message ||
          'Bluetooth discovery is unavailable. Check Bluetooth and nearby-device permissions.',
      );
    }
  };

  const stopScan = async () => {
    await stopDiscovery().catch(() => {});
    setScanning(false);
  };

  const submitJoin = async (target) => {
    const baseUrl = target?.baseUrl || manualAddress.trim();
    if (!baseUrl) {
      setManualError('Enter the host address shown on their screen.');
      return;
    }
    if (joinName.trim().length < 2) {
      setManualError('Enter the name other listeners should see.');
      return;
    }
    setJoining(true);
    setManualError('');
    setSetupError('');
    try {
      const normalized = normalizeNearbyAddress(baseUrl);
      const result = await joinNearbyRoom(normalized, joinName.trim());
      setRole('guest');
      setConnection({
        baseUrl: normalized,
        token: result.token,
        memberId: result.memberId,
        code: result.session?.code,
      });
      setSession(result.session);
      setClockOffset(Number(result.serverNow || Date.now()) - Date.now());
      setPositionMs(Number(result.session?.playback?.positionMs) || 0);
      setJoinTarget(null);
      setNotice('');
      await stopScan();
      showToast('Joined the nearby room', 'success');
    } catch (caught) {
      const message =
        caught?.code === 'NEARBY_UNREACHABLE'
          ? caught.message
          : caught?.message || 'Could not join that nearby room';
      if (target) showToast(message, 'error');
      setManualError(message);
    } finally {
      setJoining(false);
    }
  };

  const sendPlayback = async (status, nextPosition = positionMs) => {
    if (role !== 'host') return;
    const safePosition = Math.max(0, Math.round(nextPosition));
    setPlayerPaused(status !== 'playing');
    setPositionMs(safePosition);
    try {
      await updatePlayback({ status, positionMs: safePosition, rate: 1 });
      await refreshHost();
    } catch (caught) {
      showToast(caught?.message || 'Could not update local playback', 'error');
    }
  };

  const togglePlayback = () => {
    if (role !== 'host') return;
    if (playerPaused) {
      const restart = session?.playback?.status === 'ended';
      if (restart) playerRef.current?.seekTo(0);
      sendPlayback('playing', restart ? 0 : positionMs);
    } else {
      sendPlayback('paused', positionMs);
    }
  };

  const seekTo = (value) => {
    if (role !== 'host') return;
    playerRef.current?.seekTo(value / 1000);
    setPositionMs(value);
    sendPlayback(playerPaused ? 'paused' : 'playing', value);
  };

  const seekBy = (delta) => {
    const target = Math.max(0, Math.min(durationMs || Number.MAX_SAFE_INTEGER, positionMs + delta));
    seekTo(target);
  };

  const onProgress = (data) => {
    if (!sliding) setPositionMs(data.currentTime * 1000);
    if (data.seekableDuration) setDurationMs(data.seekableDuration * 1000);
    if (role === 'host' && session?.playback?.status === 'playing') {
      const now = Date.now();
      if (now - heartbeatRef.current > 2600) {
        heartbeatRef.current = now;
        updatePlayback({
          status: 'playing',
          positionMs: Math.round(data.currentTime * 1000),
          rate: 1,
        }).catch(() => {});
      }
    }
  };

  const sendChat = async () => {
    const body = chatText.trim();
    if (!body || sending || !connection) return;
    setSending(true);
    try {
      if (role === 'host') {
        await sendHostMessage(body);
        await refreshHost();
      } else {
        await sendNearbyMessage(connection.baseUrl, connection.token, body);
        await refreshGuest();
      }
      setChatText('');
    } catch (caught) {
      showToast(caught?.message || 'Message could not be sent', 'error');
    } finally {
      setSending(false);
    }
  };

  const leaveSession = async () => {
    if (leaving) return;
    setLeaving(true);
    try {
      if (role === 'host') {
        await stopHost();
      } else if (connection) {
        await leaveNearbyRoom(connection.baseUrl, connection.token);
      }
    } catch {
      // The local transport may already be gone; reset the UI regardless.
    } finally {
      if (roleRef.current === 'guest') {
        await stopDiscovery().catch(() => {});
      }
      roleRef.current = null;
      setRole(null);
      setSession(null);
      setConnection(null);
      setHostMedia(null);
      setPlayerPaused(true);
      setPositionMs(0);
      setDurationMs(0);
      setChatText('');
      setNotice('');
      setHostWarning('');
      setBleWarning('');
      setLeaving(false);
    }
  };

  const confirmLeave = () => {
    const host = role === 'host';
    Alert.alert(
      host ? 'End nearby session?' : 'Leave nearby room?',
      host
        ? 'The local server and Bluetooth beacon will stop. Guests will be disconnected.'
        : 'You will stop receiving the host’s playback and leave the local room.',
      [
        { text: 'Stay', style: 'cancel' },
        {
          text: host ? 'End session' : 'Leave',
          style: 'destructive',
          onPress: leaveSession,
        },
      ],
    );
  };

  const shareSession = async () => {
    if (!session) return;
    try {
      await Share.share({
        title: `Join ${session.name} nearby`,
        message: `Join my VibeSync nearby room “${session.name}”.\n\nOpen VibeSync → Nearby → Scan for rooms. Code: ${session.code}\nLocal address: ${connection?.baseUrl || ''}\n\nYou must be on the same Wi-Fi network or the host’s hotspot.`,
      });
    } catch {
      showToast('Could not open the share sheet', 'error');
    }
  };

  const members = session?.members || [];
  const messages = session?.messages || [];
  const playback = session?.playback;
  const totalMs = durationMs || mediaFile?.durationMs || 0;
  const isHost = role === 'host';
  const mediaUri =
    isHost && hostMedia?.uri
      ? hostMedia.uri
      : nearbyMediaUrl(connection?.baseUrl, session);
  const handleMediaLoad = (data) => {
    setDurationMs((data?.duration || 0) * 1000);
    if (role !== 'guest' || !sessionRef.current?.playback) return;
    // A late joiner's player starts at zero; jump it to the host's current
    // position as soon as the stream is ready.
    const expected = expectedNearbyPosition(
      sessionRef.current.playback,
      Date.now(),
      clockOffset,
    );
    if (expected > 250) playerRef.current?.seekTo(expected / 1000);
    setPositionMs(expected);
  };
  const videoSource = useMemo(() => {
    if (!mediaUri) return null;
    if (isHost) return { uri: mediaUri };
    return {
      uri: mediaUri,
      headers: connection?.token ? { 'X-VibeSync-Token': connection.token } : {},
    };
  }, [connection?.token, isHost, mediaUri]);
  const mediaType = hostMedia?.mediaType || session?.media?.type || preferredType;
  const liveMembers = members.filter((member) => !member.isHost);

  if (session) {
    return (
      <Screen scroll keyboardAvoiding contentContainerStyle={styles.content}>
        <View style={styles.topBar}>
          <View>
            <AppText variant="micro" color={colors.orange} style={styles.eyebrow}>
              {isHost ? 'NEARBY · HOSTING' : 'NEARBY · JOINED'}
            </AppText>
            <AppText variant="title" numberOfLines={1}>
              {session.name}
            </AppText>
          </View>
          <Pressable
            onPress={confirmLeave}
            style={styles.iconButton}
            accessibilityRole="button"
            accessibilityLabel={isHost ? 'End nearby session' : 'Leave nearby room'}
          >
            <Icon name="logout" size={19} color={colors.orange} />
          </Pressable>
        </View>

        <Card style={styles.sessionCard}>
          <View style={styles.sessionTop}>
            <View style={styles.livePill}>
              <Dot size={7} color={colors.yellow} />
              <AppText variant="micro" color={colors.offWhite}>
                LOCAL SESSION
              </AppText>
            </View>
            <Badge label={session.code} tone="orange" />
            {isHost ? <Badge label="HOST" tone="solid" /> : null}
          </View>
          <View style={styles.sessionStats}>
            <View style={styles.sessionStat}>
              <Icon name="users" size={15} color={colors.yellow} />
              <AppText variant="caption" color={colors.textMuted}>
                {members.length} here
              </AppText>
            </View>
            <View style={styles.sessionStat}>
              <Icon name="wifi" size={15} color={colors.yellow} />
              <AppText variant="caption" color={colors.textMuted}>
                Same Wi-Fi required
              </AppText>
            </View>
            <View style={styles.sessionStat}>
              <Icon name="bluetooth" size={15} color={colors.yellow} />
              <AppText variant="caption" color={colors.textMuted}>
                BLE discovery
              </AppText>
            </View>
          </View>
          {notice || hostWarning || bleWarning ? (
            <View style={styles.noticeInline}>
              <Icon name="wifiOff" size={14} color={colors.orange} />
              <AppText variant="caption" color={colors.orange} style={{ flex: 1 }}>
                {notice || hostWarning || bleWarning}
              </AppText>
            </View>
          ) : null}
        </Card>

        <Card style={styles.playerCard}>
          <View style={styles.mediaHeading}>
            <View style={styles.mediaIcon}>
              <Icon
                name={mediaType === 'audio' ? 'music' : 'video'}
                size={18}
                color={colors.black}
              />
            </View>
            <View style={{ flex: 1 }}>
              <AppText variant="micro" color={colors.orange}>
                {session.media?.title ? 'LOCAL MEDIA' : 'NO MEDIA SELECTED'}
              </AppText>
              <AppText variant="label" weight="800" numberOfLines={1}>
                {session.media?.title || hostMedia?.name || 'Waiting for media'}
              </AppText>
            </View>
            <Badge
              label={playback?.status === 'playing' ? 'PLAYING' : String(playback?.status || 'IDLE').toUpperCase()}
              tone={playback?.status === 'playing' ? 'orange' : 'neutral'}
            />
          </View>

          {videoSource && mediaType === 'video' ? (
            <View style={styles.videoWrap}>
              <Video
                ref={playerRef}
                source={videoSource}
                style={styles.video}
                resizeMode="contain"
                paused={playerPaused}
                progressUpdateInterval={500}
                onProgress={onProgress}
                onLoad={handleMediaLoad}
                onEnd={() => {
                  if (role === 'host') sendPlayback('ended', durationMs);
                }}
                playInBackground={false}
                ignoreSilentSwitch="ignore"
              />
              <View style={styles.syncTag}>
                <Dot size={6} color={isHost ? colors.orange : colors.yellow} />
                <AppText variant="micro" color={colors.offWhite}>
                  {isHost ? 'YOU CONTROL PLAYBACK' : 'SYNCED TO HOST'}
                </AppText>
              </View>
            </View>
          ) : (
            <View style={styles.audioWrap}>
              {videoSource ? (
                <Video
                  ref={playerRef}
                  source={videoSource}
                  style={styles.hiddenVideo}
                  paused={playerPaused}
                  progressUpdateInterval={500}
                  onProgress={onProgress}
                  onLoad={handleMediaLoad}
                  onEnd={() => {
                    if (role === 'host') sendPlayback('ended', durationMs);
                  }}
                  ignoreSilentSwitch="ignore"
                />
              ) : null}
              <Waveform width={180} height={34} color={colors.orange} bars={22} />
              <AppText variant="micro" color={colors.textFaint} style={{ marginTop: spacing.sm }}>
                {isHost ? 'AUDIO PLAYING FROM THIS DEVICE' : 'AUDIO STREAMING FROM THE HOST'}
              </AppText>
            </View>
          )}

          <View style={styles.progressWrap}>
            <Slider
              style={styles.slider}
              minimumValue={0}
              maximumValue={Math.max(totalMs, 1)}
              value={sliding ? slideValue : Math.min(positionMs, Math.max(totalMs, 1))}
              disabled={!isHost}
              minimumTrackTintColor={colors.orange}
              maximumTrackTintColor={colors.borderStrong}
              thumbTintColor={isHost ? colors.yellow : colors.textFaint}
              onSlidingStart={() => {
                setSliding(true);
                setSlideValue(positionMs);
              }}
              onValueChange={setSlideValue}
              onSlidingComplete={(value) => {
                setSliding(false);
                seekTo(value);
              }}
            />
            <View style={styles.timeRow}>
              <AppText variant="micro" color={colors.textMuted}>
                {formatDuration(positionMs)}
              </AppText>
              <AppText variant="micro" color={colors.textFaint}>
                {formatDuration(totalMs)}
              </AppText>
            </View>
          </View>

          <View style={styles.controls}>
            <Pressable
              onPress={() => seekBy(-10000)}
              disabled={!isHost}
              style={[styles.roundControl, !isHost && styles.controlDisabled]}
              accessibilityRole="button"
              accessibilityLabel="Back 10 seconds"
            >
              <Icon name="skipBack" size={18} />
            </Pressable>
            <Pressable
              onPress={togglePlayback}
              disabled={!isHost}
              style={[styles.playButton, !isHost && styles.controlDisabled]}
              accessibilityRole="button"
              accessibilityLabel={playerPaused ? 'Play' : 'Pause'}
            >
              <Icon name={playerPaused ? 'play' : 'pause'} size={27} color={colors.black} />
            </Pressable>
            <Pressable
              onPress={() => seekBy(10000)}
              disabled={!isHost}
              style={[styles.roundControl, !isHost && styles.controlDisabled]}
              accessibilityRole="button"
              accessibilityLabel="Forward 10 seconds"
            >
              <Icon name="skipForward" size={18} />
            </Pressable>
          </View>
          {!isHost ? (
            <AppText variant="caption" color={colors.textFaint} style={styles.guestHint}>
              Only the host can pause or seek. Playback corrects itself if your device drifts.
            </AppText>
          ) : null}
        </Card>

        <Card style={styles.peopleCard}>
          <View style={styles.sectionHeader}>
            <View>
              <AppText variant="section">In this room</AppText>
              <AppText variant="caption" color={colors.textMuted}>
                {members.length} listener{members.length === 1 ? '' : 's'} on the local network
              </AppText>
            </View>
            <Badge label="LOCAL" tone="yellow" />
          </View>
          <View style={styles.memberRow}>
            {members.slice(0, 7).map((member) => (
              <View key={member.id} style={styles.member}>
                <Avatar
                  name={member.name}
                  color={member.isHost ? colors.orange : colors.yellow}
                  size={38}
                />
                {member.isHost ? (
                  <View style={styles.hostCrown}>
                    <Icon name="spark" size={8} color={colors.black} />
                  </View>
                ) : null}
                <AppText variant="micro" color={colors.textMuted} numberOfLines={1} style={styles.memberName}>
                  {member.isHost ? 'HOST' : member.name?.split(' ')[0]}
                </AppText>
              </View>
            ))}
          </View>
          {liveMembers.length === 0 ? (
            <AppText variant="caption" color={colors.textFaint} style={{ marginTop: spacing.xs }}>
              No guests yet. They can find this room by scanning nearby or using the address
              below.
            </AppText>
          ) : null}
          <View style={styles.shareRow}>
            <Button
              title="Share invite"
              icon="share"
              variant="secondary"
              size="sm"
              onPress={shareSession}
              style={{ flex: 1 }}
            />
            <Button
              title={isHost ? 'End' : 'Leave'}
              icon="logout"
              variant="danger"
              size="sm"
              onPress={confirmLeave}
              loading={leaving}
              style={{ flex: 1 }}
            />
          </View>
        </Card>

        <Card style={styles.connectionCard}>
          <AppText variant="micro" color={colors.textMuted} style={styles.sectionLabel}>
            LOCAL CONNECTION
          </AppText>
          <ConnectionRow icon="qr" label="Room code" value={session.code} />
          <ConnectionRow icon="globe" label="Address" value={connection?.baseUrl || 'Local only'} />
          <ConnectionRow
            icon="bluetooth"
            label="Discovery"
            value={isHost ? 'Broadcasting over Bluetooth LE' : 'Connected via BLE discovery'}
          />
          <AppText variant="caption" color={colors.textFaint} style={styles.connectionHint}>
            Nearby rooms are device-to-device. No internet or VibeSync server is used for
            playback, messages, or media. Keep this app open while hosting.
          </AppText>
        </Card>

        <Card style={styles.chatCard}>
          <View style={styles.sectionHeader}>
            <AppText variant="section">Local chat</AppText>
            <Badge label={`${messages.length}`} />
          </View>
          <View style={styles.messages}>
            {messages.length === 0 ? (
              <View style={styles.emptyChat}>
                <Icon name="chat" size={20} color={colors.textFaint} />
                <AppText variant="caption" color={colors.textMuted}>
                  Say hello. Messages stay on this local room.
                </AppText>
              </View>
            ) : (
              messages.slice(-40).map((message) => {
                const mine = String(message.senderId) === String(
                  isHost ? session.members?.find((member) => member.isHost)?.id : connection?.memberId,
                );
                return (
                  <View key={message.id} style={styles.message}>
                    <Avatar name={message.senderName} size={28} color={colors.yellow} />
                    <View style={{ flex: 1 }}>
                      <View style={styles.messageMeta}>
                        <AppText variant="micro" color={mine ? colors.yellow : colors.textMuted}>
                          {mine ? 'YOU' : message.senderName}
                        </AppText>
                        <AppText variant="micro" color={colors.textFaint}>
                          {formatClockTime(message.createdAt)}
                        </AppText>
                      </View>
                      <AppText variant="caption" color={colors.offWhite} style={styles.messageBody}>
                        {message.body}
                      </AppText>
                    </View>
                  </View>
                );
              })
            )}
          </View>
          <View style={styles.composer}>
            <TextInput
              value={chatText}
              onChangeText={setChatText}
              placeholder="Message the local room…"
              placeholderTextColor={colors.textFaint}
              style={styles.chatInput}
              maxLength={1000}
              selectionColor={colors.orange}
              accessibilityLabel="Local room message"
            />
            <Pressable
              onPress={sendChat}
              disabled={!chatText.trim() || sending}
              style={[styles.sendButton, (!chatText.trim() || sending) && styles.sendDisabled]}
              accessibilityRole="button"
              accessibilityLabel="Send local message"
            >
              {sending ? (
                <ActivityIndicator color={colors.black} size="small" />
              ) : (
                <Icon name="send" size={18} color={colors.black} />
              )}
            </Pressable>
          </View>
        </Card>
    </Screen>
  );
}

  const unsupported = capabilities && !capabilities.supported;
  return (
    <Screen scroll keyboardAvoiding contentContainerStyle={styles.content}>
      <View style={styles.topBar}>
        <View style={{ flex: 1 }}>
          <AppText variant="micro" color={colors.orange} style={styles.eyebrow}>
            NO SIGNAL? NO PROBLEM.
          </AppText>
          <AppText variant="title">Nearby rooms</AppText>
          <AppText variant="body" color={colors.textMuted} style={styles.subhead}>
            Host or join a room on the same Wi-Fi — no internet needed. Bluetooth LE finds the
            room; local Wi-Fi carries playback, voice-free chat, and media.
          </AppText>
        </View>
      </View>

      {joined && room ? (
        <Pressable
          onPress={() => navigation.navigate('Room', { roomCode: room.roomId })}
          style={styles.resumeOnline}
          accessibilityRole="button"
        >
          <Icon name="headphones" size={16} color={colors.black} />
          <AppText variant="caption" weight="800" color={colors.black} numberOfLines={1} style={{ flex: 1 }}>
            You are still in {room.name} online
          </AppText>
          <Icon name="arrowRight" size={15} color={colors.black} />
        </Pressable>
      ) : null}

      {unsupported ? (
        <Card style={styles.unsupportedCard}>
          <View style={styles.unsupportedTop}>
            <View style={styles.unsupportedIcon}>
              <Icon name="wifiOff" size={19} color={colors.orange} />
            </View>
            <View style={{ flex: 1 }}>
              <AppText variant="label" weight="800">
                Native nearby transport unavailable
              </AppText>
              <AppText variant="caption" color={colors.textMuted} style={{ marginTop: 2 }}>
                {capabilities.reason}
              </AppText>
            </View>
          </View>
          <AppText variant="caption" color={colors.textFaint} style={styles.unsupportedText}>
            You can still join a host manually by entering their local address below. Hosting
            requires the compiled Android or iOS app with Bluetooth and local-network
            permissions.
          </AppText>
        </Card>
      ) : null}

      <SegmentedControl
        value={setupTab}
        onChange={(value) => {
          setSetupTab(value);
          setSetupError('');
          setManualError('');
          if (value === 'host') stopScan();
        }}
        options={[
          { value: 'host', label: 'Host', icon: 'wifi' },
          { value: 'join', label: 'Join', icon: 'nearby' },
        ]}
      />

      {setupTab === 'host' ? (
        <View style={styles.setup}>
          <Card style={styles.setupCard}>
            <AppText variant="micro" color={colors.textMuted} style={styles.sectionLabel}>
              NAME YOUR ROOM
            </AppText>
            <Input
              value={hostName}
              onChangeText={setHostName}
              placeholder="Friday night on the porch"
              maxLength={80}
              autoCapitalize="sentences"
              leftIcon="spark"
            />

            <View>
              <AppText variant="micro" color={colors.textMuted} style={styles.fieldLabel}>
                MEDIA PLAYING FROM THIS PHONE
              </AppText>
              {mediaFile ? (
                <View style={styles.fileCard}>
                  <View style={styles.fileIcon}>
                    <Icon
                      name={mediaFile.mediaType === 'audio' ? 'music' : 'video'}
                      size={19}
                      color={colors.black}
                    />
                  </View>
                  <View style={{ flex: 1 }}>
                    <AppText variant="label" weight="700" numberOfLines={1}>
                      {readableFileName(mediaFile.name) || 'Selected media'}
                    </AppText>
                    <AppText variant="micro" color={colors.textMuted}>
                      {mediaFile.mediaType.toUpperCase()}
                      {mediaFile.size ? ` · ${formatBytes(mediaFile.size)}` : ''}
                    </AppText>
                  </View>
                  <Pressable onPress={pickMedia} hitSlop={8} accessibilityRole="button">
                    <AppText variant="micro" color={colors.orange}>
                      CHANGE
                    </AppText>
                  </Pressable>
                </View>
              ) : (
                <Pressable
                  onPress={pickMedia}
                  style={styles.pickCard}
                  accessibilityRole="button"
                  accessibilityLabel="Choose a media file"
                >
                  <View style={styles.pickIcon}>
                    <Icon name="plus" size={20} color={colors.yellow} />
                  </View>
                  <AppText variant="label" weight="700">
                    Choose audio or video
                  </AppText>
                  <AppText variant="caption" color={colors.textMuted} style={{ textAlign: 'center' }}>
                    The file stays on this device and streams directly to nearby listeners.
                  </AppText>
                </Pressable>
              )}
            </View>

            <View style={styles.infoLine}>
              <Icon name="wifi" size={15} color={colors.yellow} />
              <AppText variant="caption" color={colors.textMuted} style={{ flex: 1 }}>
                Listeners must join the same Wi-Fi network or your phone’s hotspot. Bluetooth
                only announces the room; it does not carry media.
              </AppText>
            </View>
            <View style={styles.infoLine}>
              <Icon name="lock" size={15} color={colors.orange} />
              <AppText variant="caption" color={colors.textMuted} style={{ flex: 1 }}>
                Everything stays local. No account server is needed for this session; keep the
                app open while hosting.
              </AppText>
            </View>

            {setupError ? (
              <View style={styles.errorBox}>
                <Icon name="close" size={15} color={colors.orange} />
                <AppText variant="caption" color={colors.orange} style={{ flex: 1 }}>
                  {setupError}
                </AppText>
              </View>
            ) : null}

            <Button
              title={starting ? 'Starting…' : 'Start nearby room'}
              icon="wifi"
              onPress={beginHost}
              loading={starting}
              disabled={!capabilities?.supported || !mediaFile}
              size="lg"
            />
            {!capabilities ? (
              <ActivityIndicator color={colors.orange} style={{ marginTop: spacing.xs }} />
            ) : null}
          </Card>
        </View>
      ) : (
        <View style={styles.setup}>
          <Card style={styles.scanCard}>
            <View style={styles.sectionHeader}>
              <View style={{ flex: 1 }}>
                <AppText variant="section">Rooms around you</AppText>
                <AppText variant="caption" color={colors.textMuted}>
                  Bluetooth LE discovery · same Wi-Fi for playback
                </AppText>
              </View>
              <Pressable
                onPress={scanning ? stopScan : scan}
                disabled={unsupported}
                style={[styles.scanButton, unsupported && { opacity: 0.4 }]}
                accessibilityRole="button"
              >
                {scanning ? (
                  <ActivityIndicator color={colors.black} size="small" />
                ) : (
                  <Icon name="search" size={17} color={colors.black} />
                )}
              </Pressable>
            </View>

            {scanError ? (
              <View style={styles.errorBox}>
                <Icon name="bluetooth" size={15} color={colors.orange} />
                <AppText variant="caption" color={colors.orange} style={{ flex: 1 }}>
                  {scanError}
                </AppText>
              </View>
            ) : null}

            {peers.length ? (
              <View style={styles.peerList}>
                {peers.map((peer) => (
                  <Pressable
                    key={peer.id}
                    onPress={() => {
                      setJoinTarget(peer);
                      setJoinName(user?.name || '');
                      setManualError('');
                    }}
                    style={({ pressed }) => [styles.peer, pressed && { opacity: 0.82 }]}
                    accessibilityRole="button"
                    accessibilityLabel={`Join nearby room ${peer.code || 'without code'}`}
                  >
                    <View style={styles.peerIcon}>
                      <Icon name="wifi" size={18} color={colors.yellow} />
                    </View>
                    <View style={{ flex: 1 }}>
                      <AppText variant="label" weight="800">
                        Nearby room {peer.code ? `· ${peer.code}` : ''}
                      </AppText>
                      <AppText variant="caption" color={colors.textMuted} numberOfLines={1}>
                        {peer.baseUrl} · tap to join
                      </AppText>
                    </View>
                    <Icon name="arrowRight" size={16} color={colors.orange} />
                  </Pressable>
                ))}
              </View>
            ) : scanning ? (
              <View style={styles.scanning}>
                <ActivityIndicator color={colors.orange} />
                <AppText variant="caption" color={colors.textMuted} style={{ textAlign: 'center' }}>
                  Listening for nearby VibeSync rooms. Ask the host to keep their app open and
                  Bluetooth on.
                </AppText>
              </View>
            ) : (
              <View style={styles.scanning}>
                <View style={styles.scanIcon}>
                  <Icon name="bluetooth" size={22} color={colors.yellow} />
                </View>
                <AppText variant="caption" color={colors.textMuted} style={{ textAlign: 'center' }}>
                  Tap the scan button to discover rooms hosted on nearby phones. Bluetooth
                  permissions may be requested the first time.
                </AppText>
              </View>
            )}
          </Card>

          <Card style={styles.manualCard}>
            <View style={styles.sectionHeader}>
              <View style={{ flex: 1 }}>
                <AppText variant="section">Join by address</AppText>
                <AppText variant="caption" color={colors.textMuted}>
                  Use this if Bluetooth discovery is unavailable
                </AppText>
              </View>
              <Icon name="link" size={17} color={colors.orange} />
            </View>
            <Input
              label="HOST NAME"
              value={joinName}
              onChangeText={setJoinName}
              placeholder="How should the room see you?"
              maxLength={60}
              autoCapitalize="words"
              leftIcon="user"
            />
            <Input
              label="HOST ADDRESS"
              value={manualAddress}
              onChangeText={setManualAddress}
              placeholder="192.168.1.20:8787"
              autoCapitalize="none"
              keyboardType="url"
              leftIcon="globe"
            />
            {manualError ? (
              <View style={styles.errorBox}>
                <Icon name="close" size={15} color={colors.orange} />
                <AppText variant="caption" color={colors.orange} style={{ flex: 1 }}>
                  {manualError}
                </AppText>
              </View>
            ) : null}
            <Button
              title="Connect"
              icon="arrowRight"
              onPress={() => submitJoin(null)}
              loading={joining}
              size="lg"
            />
          </Card>
        </View>
      )}

      <Card style={styles.limitsCard}>
        <AppText variant="micro" color={colors.textMuted} style={styles.sectionLabel}>
          WHAT NEARBY CAN DO
        </AppText>
        <View style={styles.limitRow}>
          <Icon name="check" size={14} color={colors.yellow} />
          <AppText variant="caption" color={colors.textMuted} style={{ flex: 1 }}>
            Cross-platform Android ↔ iOS on the same Wi-Fi: BLE discovers the host; local HTTP
            carries playback state, media, and messages.
          </AppText>
        </View>
        <View style={styles.limitRow}>
          <Icon name="close" size={14} color={colors.orange} />
          <AppText variant="caption" color={colors.textMuted} style={{ flex: 1 }}>
            iOS cannot create a Wi-Fi hotspot for others, and Wi-Fi Direct is Android-only.
            Nearby rooms still need a shared network or Android hotspot.
          </AppText>
        </View>
        <View style={styles.limitRow}>
          <Icon name="close" size={14} color={colors.orange} />
          <AppText variant="caption" color={colors.textMuted} style={{ flex: 1 }}>
            BLE discovery works while the host app is in the foreground. Background hosting
            depends on OS rules and is not supported in this build.
          </AppText>
        </View>
        <View style={styles.limitRow}>
          <Icon name="check" size={14} color={colors.yellow} />
          <AppText variant="caption" color={colors.textMuted} style={{ flex: 1 }}>
            Media files are served from the host device with range requests, so seeking stays
            local and private.
          </AppText>
        </View>
      </Card>

      <Card style={styles.tipsCard}>
        <View style={styles.tipIcon}>
          <Icon name="bluetooth" size={18} color={colors.black} />
        </View>
        <View style={{ flex: 1 }}>
          <AppText variant="label" weight="700">
            Best results
          </AppText>
          <AppText variant="caption" color={colors.textMuted} style={{ marginTop: 2 }}>
            Keep both phones within a few metres for discovery, then stay on the same Wi-Fi.
            Turn off VPNs and client isolation on public networks. Performance depends on your
            router or hotspot.
          </AppText>
        </View>
      </Card>

      <ConnectingSheet
        target={joinTarget}
        name={joinName}
        onNameChange={setJoinName}
        joining={joining}
        error={manualError}
        onClose={() => {
          if (!joining) setJoinTarget(null);
        }}
        onJoin={() => submitJoin(joinTarget)}
      />
    </Screen>
  );
}

function ConnectingSheet({ target, name, onNameChange, joining, error, onClose, onJoin }) {
  if (!target) return null;
  return (
    <View style={styles.sheetStandIn}>
      <Card style={styles.connectingCard}>
        <View style={styles.sectionHeader}>
          <View style={{ flex: 1 }}>
            <AppText variant="section">Join nearby room</AppText>
            <AppText variant="caption" color={colors.textMuted}>
              {target.baseUrl}
            </AppText>
          </View>
          <Pressable onPress={onClose} disabled={joining} hitSlop={10}>
            <Icon name="close" size={19} color={colors.textMuted} />
          </Pressable>
        </View>
        <Input
          label="YOUR NAME IN THE ROOM"
          value={name}
          onChangeText={onNameChange}
          maxLength={60}
          autoCapitalize="words"
          leftIcon="user"
        />
        {error ? (
          <AppText variant="caption" color={colors.orange} style={{ marginTop: spacing.xs }}>
            {error}
          </AppText>
        ) : null}
        <Button
          title="Join room"
          icon="arrowRight"
          onPress={onJoin}
          loading={joining}
          style={{ marginTop: spacing.md }}
        />
        <AppText variant="caption" color={colors.textFaint} style={{ textAlign: 'center', marginTop: spacing.sm }}>
          You will join the host’s local session directly over Wi-Fi.
        </AppText>
      </Card>
    </View>
  );
}

const styles = StyleSheet.create({
  content: {
    paddingTop: spacing.xs,
    paddingBottom: spacing.xxxl,
    gap: spacing.md,
  },
  topBar: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.sm,
  },
  eyebrow: {
    letterSpacing: 1.6,
    marginBottom: spacing.xs,
  },
  subhead: {
    marginTop: spacing.xs,
    maxWidth: 355,
  },
  iconButton: {
    width: 42,
    height: 42,
    borderRadius: 21,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.card,
    alignItems: 'center',
    justifyContent: 'center',
  },
  resumeOnline: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    padding: spacing.sm,
    borderRadius: radius.md,
    backgroundColor: colors.yellow,
  },
  unsupportedCard: {
    gap: spacing.sm,
    borderColor: 'rgba(253,133,73,0.28)',
    backgroundColor: 'rgba(253,133,73,0.06)',
  },
  unsupportedTop: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  unsupportedIcon: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: colors.orangeSoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  unsupportedText: {
    lineHeight: 17,
  },
  setup: {
    gap: spacing.md,
  },
  setupCard: {
    gap: spacing.md,
  },
  sectionLabel: {
    letterSpacing: 1.3,
  },
  fieldLabel: {
    letterSpacing: 0.4,
    marginBottom: spacing.xs,
  },
  fileCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: 'rgba(255,193,35,0.25)',
    backgroundColor: colors.yellowSoft,
    padding: spacing.sm,
  },
  fileIcon: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: colors.yellow,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pickCard: {
    alignItems: 'center',
    gap: spacing.xs,
    paddingVertical: spacing.xl,
    paddingHorizontal: spacing.md,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: colors.borderStrong,
    backgroundColor: colors.input,
  },
  pickIcon: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: colors.yellowSoft,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.xs,
  },
  infoLine: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.xs,
  },
  errorBox: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.xs,
    padding: spacing.sm,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: 'rgba(253,133,73,0.28)',
    backgroundColor: colors.orangeSoft,
  },
  scanCard: {
    gap: spacing.md,
  },
  scanButton: {
    width: 42,
    height: 42,
    borderRadius: 21,
    backgroundColor: colors.yellow,
    alignItems: 'center',
    justifyContent: 'center',
  },
  scanIcon: {
    width: 58,
    height: 58,
    borderRadius: 29,
    backgroundColor: colors.yellowSoft,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.sm,
  },
  scanning: {
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.xl,
  },
  peerList: {
    gap: spacing.xs,
  },
  peer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    padding: spacing.sm,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.raised,
  },
  peerIcon: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: colors.yellowSoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  manualCard: {
    gap: spacing.sm,
  },
  limitsCard: {
    gap: spacing.sm,
  },
  limitRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.sm,
  },
  tipsCard: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.sm,
  },
  tipIcon: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: colors.orange,
    alignItems: 'center',
    justifyContent: 'center',
  },
  connectingCard: {
    gap: spacing.sm,
  },
  sheetStandIn: {
    marginTop: spacing.xs,
  },
  sessionCard: {
    gap: spacing.sm,
  },
  sessionTop: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    flexWrap: 'wrap',
  },
  livePill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 9,
    paddingVertical: 5,
    borderRadius: radius.pill,
    backgroundColor: colors.offWhiteSoft,
    borderWidth: 1,
    borderColor: colors.border,
  },
  sessionStats: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.md,
  },
  sessionStat: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
  },
  noticeInline: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.xs,
    padding: spacing.sm,
    borderRadius: radius.md,
    backgroundColor: colors.orangeSoft,
  },
  playerCard: {
    gap: spacing.sm,
  },
  mediaHeading: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  mediaIcon: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: colors.orange,
    alignItems: 'center',
    justifyContent: 'center',
  },
  videoWrap: {
    height: 210,
    borderRadius: radius.lg,
    overflow: 'hidden',
    backgroundColor: '#050505',
    borderWidth: 1,
    borderColor: colors.border,
  },
  video: {
    ...StyleSheet.absoluteFillObject,
  },
  hiddenVideo: {
    width: 1,
    height: 1,
    opacity: 0,
  },
  syncTag: {
    position: 'absolute',
    left: 10,
    top: 10,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: radius.pill,
    backgroundColor: 'rgba(0,0,0,0.68)',
  },
  audioWrap: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: spacing.xl,
    borderRadius: radius.lg,
    backgroundColor: colors.input,
    borderWidth: 1,
    borderColor: colors.border,
  },
  progressWrap: {
    marginTop: spacing.xs,
  },
  slider: {
    width: '100%',
    height: 34,
  },
  timeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: -4,
  },
  controls: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.lg,
    paddingVertical: spacing.xs,
  },
  roundControl: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: colors.offWhiteSoft,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  playButton: {
    width: 62,
    height: 62,
    borderRadius: 31,
    backgroundColor: colors.orange,
    alignItems: 'center',
    justifyContent: 'center',
  },
  controlDisabled: {
    opacity: 0.35,
  },
  guestHint: {
    textAlign: 'center',
  },
  peopleCard: {
    gap: spacing.sm,
  },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
  },
  memberRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.md,
    marginTop: spacing.xs,
  },
  member: {
    alignItems: 'center',
    maxWidth: 58,
  },
  hostCrown: {
    position: 'absolute',
    right: -2,
    bottom: 13,
    width: 17,
    height: 17,
    borderRadius: 9,
    backgroundColor: colors.yellow,
    borderWidth: 1,
    borderColor: colors.black,
    alignItems: 'center',
    justifyContent: 'center',
  },
  memberName: {
    marginTop: 3,
    maxWidth: 56,
    textAlign: 'center',
  },
  shareRow: {
    flexDirection: 'row',
    gap: spacing.sm,
    marginTop: spacing.xs,
  },
  connectionCard: {
    gap: spacing.xs,
  },
  connectionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    minHeight: 26,
  },
  connectionLabel: {
    width: 76,
    letterSpacing: 0.6,
  },
  connectionValue: {
    flex: 1,
    textAlign: 'right',
  },
  connectionHint: {
    marginTop: spacing.xs,
    lineHeight: 17,
  },
  chatCard: {
    gap: spacing.sm,
  },
  messages: {
    gap: spacing.sm,
  },
  emptyChat: {
    alignItems: 'center',
    gap: spacing.xs,
    paddingVertical: spacing.lg,
  },
  message: {
    flexDirection: 'row',
    gap: spacing.sm,
    alignItems: 'flex-start',
  },
  messageMeta: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: spacing.xs,
    marginBottom: 2,
  },
  messageBody: {
    lineHeight: 19,
  },
  composer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    paddingTop: spacing.sm,
  },
  chatInput: {
    ...typography.body,
    flex: 1,
    minHeight: 44,
    maxHeight: 100,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.input,
    color: colors.offWhite,
    paddingHorizontal: spacing.md,
    paddingVertical: 10,
  },
  sendButton: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: colors.orange,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sendDisabled: {
    opacity: 0.4,
  },
});
