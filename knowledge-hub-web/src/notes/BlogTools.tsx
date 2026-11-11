import React, { useState } from 'react';
import { Upload } from '@carbon/icons-react';
import { NoteBlogPublishModal } from './NoteBlogPublishModal';

/** Slim toolbar above the editor for Blog notes: saves the note, then opens the publish modal. */
export const BlogTools: React.FC<{ noteId: string; title: string; disabled: boolean; save: () => Promise<boolean> }> = ({ noteId, title, disabled, save }) => {
  const [open, setOpen] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return <>
    <div className="kh-blog-tools kh-blog-tools--sticky" role="group" aria-label="Blog publishing">
      <button type="button" className="kh-btn-ghost kh-blog-tools__publish" disabled={disabled || preparing}
        onClick={() => {
          setPreparing(true);
          setError(null);
          save().then(saved => {
            if (saved) setOpen(true);
            else setError('The note could not be saved. Resolve the editor error before publishing.');
          }).catch((e: unknown) => {
            setError(e instanceof Error ? e.message : 'The note could not be saved.');
          }).finally(() => { setPreparing(false); });
        }}>
        <Upload size={16} aria-hidden="true" /> {preparing ? 'Saving note...' : 'Publish to blog'}
      </button>
      <span className="kh-blog-tools__hint">Sends this note&rsquo;s CMS package to The Microsoft Cloud Blog.</span>
      {error !== null && <span className="kh-blog-tools__error" role="alert">{error}</span>}
    </div>
    {open && <NoteBlogPublishModal noteId={noteId} title={title} onClose={() => { setOpen(false); }} />}
  </>;
};
