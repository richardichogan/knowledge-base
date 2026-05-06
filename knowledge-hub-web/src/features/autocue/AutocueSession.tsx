/**
 * features/autocue/AutocueSession.tsx
 * Full-screen teleprompter session driven by syllable-rate detection.
 */

import React, { useState, useRef, useCallback, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, Play, Stop, Add, Subtract } from '@carbon/icons-react';
import { fetchNote } from '../../notes/noteStorage';
import { useScrollEngine } from './useScrollEngine';
import { SyllableDetector } from './SyllableDetector';
import { rateToScrollSpeed } from './rateToScrollSpeed';
import { GamepadController } from './GamepadController';

const DEFAULT_FONT_SIZE = 64;
const MIN_FONT_SIZE     = 24;
const MAX_FONT_SIZE     = 96;
const FONT_SIZE_STEP    = 4;
const MIC_PERM_KEY      = 'autocue_mic_permission';

type SessionState = 'idle' | 'running' | 'paused' | 'stopped';

function stripMarkdown(text: string): string {
  return text
    .replace(/^#{1,6}\s+/gm, '').replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/\*(.+?)\*/g, '$1').replace(/`{1,3}[^`]*`{1,3}/g, '')
    .replace(/^```[\s\S]*?```$/gm, '').replace(/^[-*+]\s+/gm, '')
    .replace(/^\d+\.\s+/gm, '').replace(/\[(.+?)\]\(.+?\)/g, '$1')
    .replace(/!\[.*?\]\(.+?\)/g, '').replace(/^>\s+/gm, '')
    .replace(/---+/g, '').trim();
}

function extractPlainText(contentJson: string): string {
  try {
    const blocks = JSON.parse(contentJson) as Array<{ content?: Array<{ text?: string }> }>;
    return blocks.flatMap((b) => b.content ?? []).map((c) => c.text ?? '')
      .join(' ').replace(/\s+/g, ' ').trim();
  } catch { return stripMarkdown(contentJson); }
}

export const AutocueSession: React.FC = () => {
  const { noteId } = useParams<{ noteId: string }>();
  const navigate   = useNavigate();

  const [sessionState, setSessionState] = useState<SessionState>('idle');
  const [fontSize, setFontSize]         = useState(DEFAULT_FONT_SIZE);
  const [controlsVisible, setControlsVisible] = useState(true);
  const [sylRate, setSylRate]           = useState(0);
  const [showMicPrompt, setShowMicPrompt] = useState(
    () => localStorage.getItem(MIC_PERM_KEY) === null,
  );
  const [gamepadToast, setGamepadToast] = useState(false);
  const [statusMsg, setStatusMsg]       = useState('');

  const sessionStateRef = useRef<SessionState>('idle');
  sessionStateRef.current = sessionState;
  const fontSizeRef = useRef(DEFAULT_FONT_SIZE);
  fontSizeRef.current = fontSize;

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
          targetSpeedRef.current = rateToScrollSpeed(sps, fontSizeRef.current);
        }
      },
      updateIntervalMs: 100,
    });
    detectorRef.current = detector;
    try {
      await detector.start();
      setStatusMsg('');
    } catch {
      setStatusMsg('⚠ Microphone error — check permissions');
    }
  }, [targetSpeedRef]);

  const stopDetector = useCallback(() => {
    detectorRef.current?.stop();
    detectorRef.current = null;
    targetSpeedRef.current = 0;
    setSylRate(0);
  }, [targetSpeedRef]);

  // ── Session control ───────────────────────────────────────────────────────

  const handlePlay = useCallback(async () => {
    const micPerm = localStorage.getItem(MIC_PERM_KEY);
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
    localStorage.setItem(MIC_PERM_KEY, 'granted');
    setShowMicPrompt(false);
    void handlePlay();
  }, [handlePlay]);

  const handleMicSkip = useCallback(() => {
    localStorage.setItem(MIC_PERM_KEY, 'skipped');
    setShowMicPrompt(false);
    void handlePlay();
  }, [handlePlay]);

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

  // Cleanup on unmount
  useEffect(() => () => { stopDetector(); }, [stopDetector]);

  // ── Render ────────────────────────────────────────────────────────────────

  const scriptText  = note ? extractPlainText(note.contentJson) : '';
  const scriptWords = scriptText ? scriptText.split(/\s+/).filter(Boolean) : [];

  // Rate bar 0–6 syl/sec scale
  const rateBarPct = Math.min(100, Math.round((sylRate / 6) * 100));

  return (
    <div className="ac-session">

      {statusMsg && (
        <div className={`ac-banner${statusMsg.startsWith('⚠') ? ' ac-banner--error' : ''}`}>
          {statusMsg}
        </div>
      )}

      {/* Syllable rate indicator */}
      <div className={`ac-status${isScrolling.current ? ' ac-status--dim' : ''}`}>
        <span className="ac-status__rate-bar-wrap">
          <span className="ac-status__rate-bar-fill" style={{ width: `${rateBarPct}%` }} />
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
          <p className="ac-script-text">
            {scriptWords.length > 0
              ? scriptWords.map((word, i) => (
                  <span key={i} className="ac-word">{word}{' '}</span>
                ))
              : 'Loading…'}
          </p>
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
