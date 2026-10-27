import React, { useId } from 'react';
import { VolumeDown } from '@carbon/icons-react';
import { ComposerControl } from './ComposerControl';
import { MAX_VOICE_VOLUME } from './voiceVolume';

export function VoiceVolumeControl({ value, onChange }: { value: number; onChange: (value: number) => void }): React.ReactElement {
  const id = useId();
  const slider = (suffix: string): React.ReactElement => (
    <label className="ai-voice-volume__slider" htmlFor={`${id}-${suffix}`}>
      <span className="ai-voice-volume__label">Volume</span>
      <input id={`${id}-${suffix}`} type="range" min={0} max={MAX_VOICE_VOLUME} step={1}
        aria-label="Athena voice volume" aria-valuetext={`${value}%`} value={value}
        onChange={event => { onChange(event.target.valueAsNumber); }} />
      <span className="ai-voice-volume__value" aria-hidden="true">{value}%</span>
    </label>
  );
  return <div className="ai-voice-volume">
    <div className="ai-voice-volume__inline">{slider('inline')}</div>
    <div className="ai-voice-volume__compact">
      <ComposerControl label="Athena voice volume" icon={<VolumeDown size={16} />} closeOnChange={false}>
        {slider('compact')}
      </ComposerControl>
    </div>
  </div>;
}
