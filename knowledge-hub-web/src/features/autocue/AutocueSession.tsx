/**
 * features/autocue/AutocueSession.tsx
 * Full-screen teleprompter session driven by syllable-rate detection.
 */

import React, { useState, useRef, useCallback, useEffect } from 'react';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, Play, Stop, Add, Subtract } from '@carbon/icons-react';
import { fetchNote } from '../../notes/noteStorage';
import { useScrollEngine } from './useScrollEngine';
import { SyllableDetector } from './SyllableDetector';
import { rateToScrollSpeed, countSyllables, DEFAULT_SYLLABLES_PER_LINE, LINE_HEIGHT_RATIO } from './rateToScrollSpeed';
import { GamepadController } from './GamepadController';
import { autocueScriptText } from './scriptText';
import { AUTOCUE_FONT_SIZE, AUTOCUE_FONT_KEY, AUTOCUE_SENSITIVITY_KEY, readAutocueSettings } from './settings';

const DEFAULT_FONT_SIZE = AUTOCUE_FONT_SIZE.default;
const MIN_FONT_SIZE     = AUTOCUE_FONT_SIZE.min;
const MAX_FONT_SIZE     = AUTOCUE_FONT_SIZE.max;
const FONT_SIZE_STEP    = AUTOCUE_FONT_SIZE.step;
const MIC_PERM_KEY      = 'autocue_mic_permission';

// iPad/iOS needs higher sensitivity due to lower mic gain
const DEFAULT_SENSITIVITY_DESKTOP = 0.05;
const DEFAULT_SENSITIVITY_IOS = 0.25;  // Much higher for iOS - mic is less sensitive

type SessionState = 'idle' | 'running' | 'paused' | 'stopped';

function isIOSDevice(): boolean {
  return /iPad|iPhone|iPod/.test(navigator.userAgent) || 
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

export const AutocueSession: React.FC = () => {
  const { noteId } = useParams<{ noteId: string }>();
  const navigate   = useNavigate();
  const [searchParams] = useSearchParams();
  
  // Use higher default sensitivity on iOS devices
  const defaultSensitivity = isIOSDevice() ? DEFAULT_SENSITIVITY_IOS : DEFAULT_SENSITIVITY_DESKTOP;
  const [initialSettings] = useState(() => {
    try { return { ...readAutocueSettings(localStorage, defaultSensitivity, searchParams.get('sensitivity')),
      micPermission: localStorage.getItem(MIC_PERM_KEY) }; }
    catch {
      return { fontSize: DEFAULT_FONT_SIZE, sensitivity: defaultSensitivity, micPermission: null,
        error: 'Teleprompter settings cannot be read on this device.' };
    }
  });
  const [settingsError, setSettingsError] = useState(initialSettings.error);
  
  const [sensitivity, setSensitivity] = useState(initialSettings.sensitivity);
  const [sessionState, setSessionState] = useState<SessionState>('idle');
  const [fontSize, setFontSize]         = useState<number>(initialSettings.fontSize);
  const [controlsVisible, setControlsVisible] = useState(true);
  const [sylRate, setSylRate]           = useState(0);
  const [showMicPrompt, setShowMicPrompt] = useState(initialSettings.micPermission === null);
  const micPermissionRef = useRef(initialSettings.micPermission);
  const [gamepadToast, setGamepadToast] = useState(false);
  const [statusMsg, setStatusMsg]       = useState('');

  const sessionStateRef = useRef<SessionState>('idle');
  sessionStateRef.current = sessionState;
  const fontSizeRef = useRef<number>(initialSettings.fontSize);
  fontSizeRef.current = fontSize;
  const sylPerLineRef = useRef<number>(DEFAULT_SYLLABLES_PER_LINE);
  
  useEffect(() => {
    try {
      localStorage.setItem(AUTOCUE_SENSITIVITY_KEY, sensitivity.toString());
      localStorage.setItem(AUTOCUE_FONT_KEY, fontSize.toString());
    } catch { setSettingsError('Teleprompter settings could not be saved. They will reset when you reopen it.'); }
  }, [sensitivity, fontSize]);

  const { data: note } = useQuery({
    queryKey: ['note', noteId],
    queryFn:  () => fetchNote(noteId ?? ''),
    enabled:  noteId !== undefined,
  });

  const { containerRef, targetSpeedRef, reset, isScrolling } = useScrollEngine();
  const detectorRef = useRef<SyllableDetector | null>(null);
  const gamepadRef  = useRef<GamepadController | null>(null);

  // ── Detector ─────────────────────────────────────────────────────────────

  const startDetector = useCallback(async () => {
    detectorRef.current?.stop();
    const detector = new SyllableDetector({
      onRateUpdate: (sps) => {
        setSylRate(sps);
        if (sessionStateRef.current === 'running') {
          targetSpeedRef.current = rateToScrollSpeed(sps, fontSizeRef.current, sylPerLineRef.current);
        }
      },
      updateIntervalMs: 100,
      fallbackThreshold: sensitivity,
    });
    detectorRef.current = detector;
    try {
      await detector.start();
      setStatusMsg('');
    } catch {
      setStatusMsg('⚠ Microphone error — check permissions');
    }
  }, [targetSpeedRef, sensitivity]);

  const stopDetector = useCallback(() => {
    detectorRef.current?.stop();
    detectorRef.current = null;
    targetSpeedRef.current = 0;
    setSylRate(0);
  }, [targetSpeedRef]);

  // ── Session control ───────────────────────────────────────────────────────

  const handlePlay = useCallback(async () => {
    const micPerm = micPermissionRef.current;
    setSessionState('running');
    setControlsVisible(false);
    if (micPerm === 'granted') {
      await startDetector();
    } else {
      targetSpeedRef.current = 80; // manual fallback
    }
  }, [startDetector, targetSpeedRef]);

  const handlePause = useCallback(() => {
    setSessionState('paused');
    setControlsVisible(true);
    targetSpeedRef.current = 0;
    stopDetector();
  }, [stopDetector, targetSpeedRef]);

  const handleStop = useCallback(() => {
    setSessionState('stopped');
    setControlsVisible(true);
    stopDetector();
    reset();
    setTimeout(() => setSessionState('idle'), 50);
  }, [stopDetector, reset]);

  const togglePlay = useCallback(() => {
    if (sessionStateRef.current === 'running') handlePause();
    else void handlePlay();
  }, [handlePlay, handlePause]);

  // ── Font ──────────────────────────────────────────────────────────────────

  const adjustFont = useCallback((delta: number) => {
    setFontSize((f) => Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, f + delta)));
  }, []);

  // ── Tap script area ───────────────────────────────────────────────────────

  const handleScriptAreaClick = useCallback(() => {
    if (sessionStateRef.current === 'running') handlePause();
    else setControlsVisible((v) => !v);
  }, [handlePause]);

  // ── Mic permission ────────────────────────────────────────────────────────

  const handleMicAllow = useCallback(() => {
    micPermissionRef.current = 'granted';
    try { localStorage.setItem(MIC_PERM_KEY, 'granted'); }
    catch { setSettingsError('Microphone preference could not be saved on this device.'); }
    setShowMicPrompt(false);
    void handlePlay();
  }, [handlePlay]);

  const handleMicSkip = useCallback(() => {
    micPermissionRef.current = 'skipped';
    try { localStorage.setItem(MIC_PERM_KEY, 'skipped'); }
    catch { setSettingsError('Microphone preference could not be saved on this device.'); }
    setShowMicPrompt(false);
    void handlePlay();
  }, [handlePlay]);

  // ── Derived script text (needed by effects below) ────────────────────────

  const script = React.useMemo(() => {
    try { return { text: note ? autocueScriptText(note.contentJson) : '', error: '' }; }
    catch (error) { return { text: '', error: error instanceof Error ? error.message : 'Could not read the teleprompter script.' }; }
  }, [note]);
  const scriptText = script.text;
  
  // Split into paragraphs to preserve structure
  const scriptParagraphs = React.useMemo(() => {
    if (!scriptText) return [];
    return scriptText.split(/\n\n/);
  }, [scriptText]);

  // ── Gamepad ───────────────────────────────────────────────────────────────

  useEffect(() => {
    const lineH = fontSizeRef.current * 1.6;
    const ctrl = new GamepadController({
      onStart:     () => void handlePlay(),
      onPause:     () => handlePause(),
      onStop:      () => handleStop(),
      onSpeedUp:   () => { if (containerRef.current) containerRef.current.scrollTop += lineH; },
      onSpeedDown: () => { if (containerRef.current) containerRef.current.scrollTop -= lineH; },
      onBack:      () => navigate('/autocue'),
      onGamepadConnected: () => {
        setGamepadToast(true);
        setTimeout(() => setGamepadToast(false), 2000);
      },
    });
    ctrl.connect();
    gamepadRef.current = ctrl;
    return () => { ctrl.disconnect(); };
  }, [handlePlay, handlePause, handleStop, navigate, containerRef]);

  // Font size CSS var
  useEffect(() => {
    containerRef.current?.style.setProperty('--autocue-font-size', `${fontSize}px`);
  }, [fontSize, containerRef]);

  // Recalculate syllables-per-line whenever the script or font size changes.
  // Measures the actual rendered scroll height to count lines precisely.
  useEffect(() => {
    const el = containerRef.current;
    if (!el || !scriptText) return;
    // Wait one frame for layout to settle
    const id = requestAnimationFrame(() => {
      const linePixels = fontSize * LINE_HEIGHT_RATIO;
      const totalLines = el.scrollHeight / linePixels;
      const totalSyllables = countSyllables(scriptText);
      if (totalLines > 0 && totalSyllables > 0) {
        sylPerLineRef.current = totalSyllables / totalLines;
      }
    });
    return () => cancelAnimationFrame(id);
  }, [scriptText, fontSize, containerRef]);

  // Cleanup on unmount
  useEffect(() => () => { stopDetector(); }, [stopDetector]);

  // ── Render ────────────────────────────────────────────────────────────────

  // Rate bar 0–6 syl/sec scale
  const rateBarPct = Math.min(100, Math.round((sylRate / 6) * 100));

  return (
    <div className="ac-session">
      {(settingsError || script.error) && <div className="ac-banner ac-banner--error" role="alert">{script.error || settingsError}</div>}

      {statusMsg && (
        <div className={`ac-banner${statusMsg.startsWith('⚠') ? ' ac-banner--error' : ''}`}>
          {statusMsg}
        </div>
      )}

      {/* Syllable rate indicator */}
      <div className={`ac-status${isScrolling.current ? ' ac-status--dim' : ''}${sylRate > 1 ? ' ac-status--active' : ''}`}>
        <span className="ac-status__rate-bar-wrap">
          <span
            className="ac-status__rate-bar-fill"
            style={{ width: `${rateBarPct}%` }}
          />
        </span>
        <span className="ac-status__label">
          {sessionState === 'running'
            ? `${sylRate.toFixed(1)} SYL/S`
            : sessionState === 'paused' ? 'PAUSED' : 'READY'}
        </span>
      </div>

      {/* Script area */}
      <div
        ref={containerRef as React.RefObject<HTMLDivElement>}
        className="ac-script-area"
        onClick={handleScriptAreaClick}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => { if (e.key === ' ') togglePlay(); }}
        aria-label="Script area — tap to pause"
      >
        <div className="ac-script-inner">
          {scriptParagraphs.length > 0
            ? scriptParagraphs.map((paragraph, pIndex) => (
                <p key={pIndex} className="ac-script-text">
                  {paragraph || '\u00a0'}
                </p>
              ))
            : <p className="ac-script-text">Loading…</p>}
        </div>
      </div>

      {/* Controls */}
      {controlsVisible && (
        <div className="ac-controls">
          <button className="ac-ctrl-btn" onClick={() => navigate('/autocue')} title="Back">
            <ArrowLeft size={20} />
          </button>
          <button className="ac-ctrl-btn ac-ctrl-btn--primary" onClick={togglePlay}
            title={sessionState === 'running' ? 'Pause' : 'Play'}>
            {sessionState === 'running' ? <Stop size={20} /> : <Play size={20} />}
          </button>
          <button className="ac-ctrl-btn" onClick={handleStop} title="Stop and reset">
            <Stop size={20} />
          </button>
          <div className="ac-ctrl-group">
            <button className="ac-ctrl-btn ac-ctrl-btn--sm" onClick={() => adjustFont(-FONT_SIZE_STEP)}
              title="Smaller text" disabled={fontSize <= MIN_FONT_SIZE}><Subtract size={16} /></button>
            <span className="ac-ctrl-label">{fontSize}px</span>
            <button className="ac-ctrl-btn ac-ctrl-btn--sm" onClick={() => adjustFont(FONT_SIZE_STEP)}
              title="Larger text" disabled={fontSize >= MAX_FONT_SIZE}><Add size={16} /></button>
          </div>
          <div className="ac-ctrl-group">
            <span className="ac-ctrl-label">Mic</span>
            <input
              type="range"
              min="0.01"
              max="0.30"
              step="0.01"
              value={sensitivity}
              onChange={(e) => setSensitivity(parseFloat(e.target.value))}
              className="ac-sensitivity-slider"
              title={`Voice sensitivity: ${sensitivity.toFixed(2)}`}
            />
          </div>
        </div>
      )}

      {/* Mic permission prompt */}
      {showMicPrompt && (
        <div className="ac-mic-overlay">
          <div className="ac-mic-card">
            <p className="ac-mic-text">
              Voice control needs microphone access. Audio is analysed on-device only —
              nothing is recorded or sent anywhere. The system measures only how fast you
              are speaking, not what you say.
            </p>
            <div className="ac-mic-actions">
              <button className="ac-mic-btn ac-mic-btn--primary" onClick={handleMicAllow}>
                Allow microphone
              </button>
              <button className="ac-mic-btn" onClick={handleMicSkip}>
                Skip — manual control only
              </button>
            </div>
          </div>
        </div>
      )}

      {gamepadToast && <div className="ac-toast">Controller connected</div>}
    </div>
  );
};
