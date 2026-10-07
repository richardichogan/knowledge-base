import React, { useEffect, useId, useRef, useSyncExternalStore } from 'react';
import { Close, Information, WarningAlt, CheckmarkFilled } from '@carbon/icons-react';
import { createPortal } from 'react-dom';
import { currentDialog, settleDialog, subscribeDialogs } from '../services/appDialogs';

export const AppDialog: React.FC<{
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  actions: React.ReactNode;
  tone?: 'info' | 'success' | 'danger';
  wide?: boolean;
  alert?: boolean;
}> = ({ title, onClose, children, actions, tone = 'info', wide = false, alert = false }) => {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const bodyId = useId();
  useEffect(() => {
    const dialog = ref.current;
    const previousFocus = document.activeElement;
    dialog?.showModal();
    dialog?.querySelector<HTMLElement>('[data-dialog-autofocus]')?.focus();
    return () => {
      dialog?.close();
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus();
    };
  }, []);
  const Icon = tone === 'danger' ? WarningAlt : tone === 'success' ? CheckmarkFilled : Information;
  function handleKeyDown(e: React.KeyboardEvent<HTMLDialogElement>): void {
    e.stopPropagation();
    if (e.key !== 'Tab') return;
    const controls = Array.from(e.currentTarget.querySelectorAll<HTMLElement>(
      'button:not(:disabled), a[href], input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [tabindex="0"]',
    )).filter((el) => el.getClientRects().length > 0);
    const first = controls[0];
    const last = controls[controls.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last?.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first?.focus();
    }
  }
  return createPortal(
    <dialog ref={ref} className={`kh-dialog kh-dialog--${tone}${wide ? ' kh-dialog--wide' : ''}`}
      role={alert ? 'alertdialog' : 'dialog'} aria-labelledby={titleId} aria-describedby={alert ? bodyId : undefined} aria-modal="true"
      onCancel={(e) => { e.preventDefault(); onClose(); }}
      onKeyDown={handleKeyDown}
      onClick={(e) => { e.stopPropagation(); }}>
      <header className="kh-dialog__header">
        <Icon size={24} className="kh-dialog__icon" />
        <h2 id={titleId}>{title}</h2>
        <button type="button" className="kh-dialog__close" aria-label="Close dialog" onClick={onClose}><Close size={20} /></button>
      </header>
      <div id={bodyId} className="kh-dialog__body">{children}</div>
      <footer className="kh-dialog__actions">{actions}</footer>
    </dialog>, document.body,
  );
};

export const AppDialogHost: React.FC = () => {
  const request = useSyncExternalStore(subscribeDialogs, currentDialog, () => null);
  if (!request) return null;
  const close = (): void => { settleDialog(request.id, false); };
  return <AppDialog key={request.id} alert
    title={request.title ?? (request.kind === 'confirm' ? 'Confirm action' : 'Athena')}
    tone={request.tone ?? 'info'} onClose={close}
    actions={<>
      {request.kind === 'confirm' && <button type="button" className="kh-dialog__button" data-dialog-autofocus onClick={close}>Cancel</button>}
      <button type="button" className={`kh-dialog__button kh-dialog__button--${request.tone === 'danger' ? 'danger' : 'primary'}`}
        data-dialog-autofocus={request.kind === 'alert' ? '' : undefined} onClick={() => { settleDialog(request.id, true); }}>
        {request.confirmLabel ?? (request.kind === 'confirm' ? 'Continue' : 'OK')}
      </button>
    </>}>
    <p className="kh-dialog__message">{request.message}</p>
  </AppDialog>;
};
