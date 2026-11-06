import React, {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Animated, Platform, StyleSheet, View } from 'react-native';
import Video from 'react-native-video';
import { mediaApi } from '../api/endpoints';
import { absoluteMediaUrl } from '../api/client';
import { colors, radius } from '../theme';
import AppText from '../components/AppText';
import Icon, { Waveform } from '../components/Icon';
import { decideCorrection, expectedPosition } from '../sync/PlaybackSync';
import { HOST_HEARTBEAT_INTERVAL_MS } from '../config';

const DRM_SCHEMES = new Set(['widevine', 'fairplay', 'playready', 'clearkey']);

const SyncedMediaPlayer = forwardRef(function SyncedMediaPlayer(
  {
    playback,
    media,
    isHost,
    serverNow,
    onCommand,
    reportPosition,
    style,
    onPosition,
    onDuration,
    reduceMotion = false,
  },
  ref,
) {
  const videoRef = useRef(null);
  const [headers, setHeaders] = useState({});
  const [paused, setPaused] = useState(true);
  const [rate, setRate] = useState(1);
  const [duration, setDuration] = useState((media?.durationMs || 0) / 1000);
  const [position, setPosition] = useState(0);
  const [buffering, setBuffering] = useState(false);
  const [error, setError] = useState(null);
  const [loaded, setLoaded] = useState(false);
  const positionRef = useRef(0);
  const playbackRef = useRef(playback);
  const mediaRef = useRef(media);
  const pulse = useRef(new Animated.Value(0.4)).current;

  playbackRef.current = playback;
  mediaRef.current = media;

  const isVideo = media?.type === 'video';
  const source = useMemo(() => {
    if (!media) return null;
    const url =
      media.source === 'upload'
        ? absoluteMediaUrl(media.streamUrl)
        : media.url;
    if (!url) return null;
    const drmScheme = String(media.drmScheme || '').toLowerCase();
    const drm =
      DRM_SCHEMES.has(drmScheme) && media.drmLicenseUrl
        ? {
            type: drmScheme,
            licenseServer: media.drmLicenseUrl,
            headers: headers.Authorization
              ? { Authorization: headers.Authorization }
              : undefined,
          }
        : undefined;
    return {
      uri: url,
      headers: media.source === 'upload' ? headers : undefined,
      ...(drm ? { drm } : {}),
    };
  }, [media, headers]);

  useEffect(() => {
    let active = true;
    if (media?.source === 'upload') {
      mediaApi
        .authHeaders()
        .then((nextHeaders) => {
          if (active) setHeaders(nextHeaders);
        })
        .catch(() => {});
    } else {
      setHeaders({});
    }
    return () => {
      active = false;
    };
  }, [media?.id, media?.source]);

  useEffect(() => {
    setLoaded(false);
    setError(null);
    setPosition(0);
    positionRef.current = 0;
    setDuration((media?.durationMs || 0) / 1000);
  }, [media?.id, media?.durationMs]);

  useEffect(() => {
    if (paused) {
      pulse.stopAnimation();
      return undefined;
    }
    if (reduceMotion) {
      pulse.setValue(0.7);
      return undefined;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1, duration: 700, useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 0.45, duration: 700, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [paused, pulse, reduceMotion]);

  const seekTo = useCallback(
    (positionMs, toleranceMs = 180) => {
      if (!videoRef.current) return;
      const seconds = Math.max(0, positionMs / 1000);
      if (Math.abs(positionRef.current - seconds) * 1000 < toleranceMs) return;
      videoRef.current.seek(seconds);
      positionRef.current = seconds;
      setPosition(seconds);
      onPosition?.(seconds);
    },
    [onPosition],
  );

  useImperativeHandle(
    ref,
    () => ({
      seekTo,
      getPositionMs: () => Math.round(positionRef.current * 1000),
      enterFullscreen: () => {
        if (videoRef.current?.presentFullscreenPlayer) {
          videoRef.current.presentFullscreenPlayer();
        }
      },
    }),
    [seekTo],
  );

  const applyExpectedPosition = useCallback(
    (force = false) => {
      const currentPlayback = playbackRef.current;
      const durationMs =
        currentPlayback?.durationMs || (mediaRef.current?.durationMs || 0) || duration * 1000;
      const targetMs = expectedPosition(currentPlayback, serverNow(), durationMs);
      const currentMs = positionRef.current * 1000;
      const correction = decideCorrection({
        currentPositionMs: currentMs,
        targetPositionMs: targetMs,
        playing: currentPlayback?.status === 'playing',
        rate: currentPlayback?.rate || 1,
      });
      if (force || correction.type === 'seek') {
        seekTo(targetMs, 120);
        setRate(currentPlayback?.rate || 1);
        return;
      }
      if (
        correction.type === 'rate' &&
        currentPlayback?.status === 'playing' &&
        !isHost
      ) {
        setRate(correction.rate);
        return;
      }
      if ((currentPlayback?.rate || 1) !== rate) setRate(currentPlayback?.rate || 1);
    },
    [duration, isHost, rate, seekTo, serverNow],
  );

  // React to authoritative playback transitions.
  useEffect(() => {
    if (!playback || !media) {
      setPaused(true);
      return;
    }
    const mediaChanged = String(playback.mediaId) !== String(media.id);
    if (mediaChanged) return;
    if (playback.status === 'playing') {
      setPaused(false);
      setRate(playback.rate || 1);
      if (!loaded) applyExpectedPosition(true);
    } else if (playback.status === 'paused' || playback.status === 'idle') {
      setPaused(true);
      setRate(playback.rate || 1);
      seekTo(playback.computedPositionMs ?? playback.positionMs, 350);
    } else if (playback.status === 'ended') {
      setPaused(true);
      setRate(playback.rate || 1);
      seekTo(playback.durationMs || playback.positionMs, 350);
    }
  }, [applyExpectedPosition, loaded, media, playback, seekTo]);

  // Periodic drift correction for listeners. Hosts do not fight their own
  // player; their reported heartbeat becomes the authoritative anchor.
  useEffect(() => {
    if (isHost || !playback || playback.status !== 'playing') return undefined;
    const timer = setInterval(() => applyExpectedPosition(false), 2200);
    return () => clearInterval(timer);
  }, [applyExpectedPosition, isHost, playback]);

  useEffect(() => {
    if (!isHost || playback?.status !== 'playing') return undefined;
    const timer = setInterval(() => {
      if (positionRef.current > 0) reportPosition?.(positionRef.current * 1000);
    }, HOST_HEARTBEAT_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [isHost, playback?.status, reportPosition]);

  const onLoad = useCallback(
    (event) => {
      setLoaded(true);
      setBuffering(false);
      const nextDuration = event.duration || (media?.durationMs || 0) / 1000;
      setDuration(nextDuration);
      onDuration?.(Math.round(nextDuration * 1000));
      if (playbackRef.current?.status === 'playing') {
        applyExpectedPosition(true);
      } else {
        seekTo(
          playbackRef.current?.computedPositionMs ?? playbackRef.current?.positionMs ?? 0,
          260,
        );
      }
    },
    [applyExpectedPosition, media?.durationMs, onDuration, seekTo],
  );

  const onProgress = useCallback(
    (event) => {
      positionRef.current = event.currentTime;
      setPosition(event.currentTime);
      onPosition?.(event.currentTime);
    },
    [onPosition],
  );

  const onEnd = useCallback(() => {
    setPaused(true);
    if (isHost) {
      onCommand?.('ended', { positionMs: Math.round(duration * 1000) }).catch(() => {});
    }
  }, [duration, isHost, onCommand]);

  const onVideoError = useCallback((event) => {
    const description =
      event?.error?.errorString ||
      event?.error?.localizedDescription ||
      'This media could not be played on this device.';
    setError(description);
    setBuffering(false);
  }, []);

  const progress = duration > 0 ? Math.min(1, position / duration) : 0;
  const drmProtected = Boolean(media?.drmScheme);

  if (!media) {
    return (
      <View style={[styles.empty, style]}>
        <View style={styles.emptyArt}>
          <Icon name="music" size={30} color={colors.textFaint} />
        </View>
        <AppText variant="body" color={colors.textMuted}>
          The host has not selected anything yet
        </AppText>
      </View>
    );
  }

  return (
    <View style={[styles.container, style]}>
      {isVideo ? (
        <>
          {source ? (
            <Video
              ref={videoRef}
              source={source}
              style={StyleSheet.absoluteFill}
              paused={paused}
              rate={rate}
              volume={1}
              muted={false}
              resizeMode="contain"
              repeat={false}
              playInBackground={false}
              playWhenInactive={false}
              ignoreSilentSwitch="ignore"
              progressUpdateInterval={400}
              onLoad={onLoad}
              onProgress={onProgress}
              onEnd={onEnd}
              onError={onVideoError}
              onBuffer={({ isBuffering }) => setBuffering(Boolean(isBuffering))}
              {...(Platform.OS === 'android' ? { disableFocus: false } : {})}
            />
          ) : null}
        </>
      ) : (
        <>
          {source ? (
            <Video
              ref={videoRef}
              source={source}
              style={styles.hiddenVideo}
              paused={paused}
              rate={rate}
              volume={1}
              repeat={false}
              playInBackground={false}
              playWhenInactive={false}
              ignoreSilentSwitch="ignore"
              progressUpdateInterval={400}
              onLoad={onLoad}
              onProgress={onProgress}
              onEnd={onEnd}
              onError={onVideoError}
            />
          ) : null}
          <View style={styles.audioArt}>
            <View style={styles.audioDisc}>
              <Animated.View style={[styles.audioGlow, { opacity: pulse }]} />
              <Waveform width={128} height={46} color={colors.orange} bars={24} />
              <AppText variant="micro" color={colors.textFaint} style={styles.audioLabel}>
                {paused ? 'PAUSED' : isHost ? 'PLAYING · HOST' : 'SYNCED TO HOST'}
              </AppText>
            </View>
          </View>
        </>
      )}

      {buffering && !error ? (
        <View style={styles.centerOverlay} pointerEvents="none">
          <AppText variant="caption" color={colors.textMuted}>
            Buffering…
          </AppText>
        </View>
      ) : null}

      {error ? (
        <View style={styles.errorOverlay}>
          <Icon name="headphonesOff" size={24} color={colors.orange} />
          <AppText variant="caption" color={colors.offWhite} style={styles.errorText}>
            {error}
          </AppText>
          {drmProtected ? (
            <AppText variant="micro" color={colors.textMuted} style={styles.drmText}>
              {String(media.drmScheme).toUpperCase()} CONTENT · PROVIDER LICENSE REQUIRED
            </AppText>
          ) : null}
        </View>
      ) : null}

      {drmProtected && !error ? (
        <View style={styles.drmBadge} pointerEvents="none">
          <Icon name="shield" size={12} color={colors.yellow} />
          <AppText variant="micro" color={colors.yellow}>
            {String(media.drmScheme).toUpperCase()}
          </AppText>
        </View>
      ) : null}

      <View style={styles.progressTrack} pointerEvents="none">
        <View style={[styles.progressFill, { width: `${progress * 100}%` }]} />
      </View>
    </View>
  );
});

export default SyncedMediaPlayer;

const styles = StyleSheet.create({
  container: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    overflow: 'hidden',
    aspectRatio: 16 / 10,
    borderWidth: 1,
    borderColor: colors.border,
    justifyContent: 'center',
    alignItems: 'center',
  },
  hiddenVideo: {
    width: 1,
    height: 1,
    opacity: 0,
    position: 'absolute',
  },
  audioArt: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.card,
  },
  audioDisc: {
    width: '76%',
    aspectRatio: 1,
    maxWidth: 240,
    borderRadius: 999,
    backgroundColor: colors.black,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  audioGlow: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: colors.orangeSoft,
  },
  audioLabel: {
    position: 'absolute',
    bottom: '17%',
    letterSpacing: 1.5,
  },
  centerOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.28)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  errorOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.88)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
    gap: 8,
  },
  errorText: {
    textAlign: 'center',
    maxWidth: 300,
  },
  drmText: {
    textAlign: 'center',
    marginTop: 4,
  },
  drmBadge: {
    position: 'absolute',
    top: 12,
    left: 12,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    backgroundColor: colors.yellowSoft,
    borderWidth: 1,
    borderColor: 'rgba(255,193,35,0.3)',
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 999,
  },
  progressTrack: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    height: 2,
    backgroundColor: 'rgba(241,243,245,0.10)',
  },
  progressFill: {
    height: 2,
    backgroundColor: colors.orange,
  },
  empty: {
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.card,
    aspectRatio: 16 / 10,
    justifyContent: 'center',
    alignItems: 'center',
    gap: 14,
  },
  emptyArt: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: colors.offWhiteSoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
