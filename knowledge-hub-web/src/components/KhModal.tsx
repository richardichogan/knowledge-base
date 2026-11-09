import React from 'react';
import { AppDialog } from './AppDialog';

type KhModalProps = {
  open?: boolean;
  modalHeading: string;
  modalLabel?: string;
  primaryButtonText?: string;
  secondaryButtonText?: string;
  primaryButtonDisabled?: boolean;
  danger?: boolean;
  passiveModal?: boolean;
  size?: 'xs' | 'sm' | 'md' | 'lg';
  className?: string;
  onRequestClose?: () => void;
  onRequestSubmit?: () => void;
  onSecondarySubmit?: () => void;
  children?: React.ReactNode;
  hasScrollingContent?: boolean;
};

/** Carbon-Modal-shaped adapter that renders the shared Athena dialog so every modal looks and behaves the same. */
export const KhModal: React.FC<KhModalProps> = ({
  open = true, modalHeading, modalLabel, primaryButtonText, secondaryButtonText, primaryButtonDisabled = false, danger = false,
  passiveModal = false, size, className, onRequestClose, onRequestSubmit, onSecondarySubmit, children,
}) => {
  if (!open) return null;
  const close = (): void => { onRequestClose?.(); };
  const actions = passiveModal ? null : <>
    {secondaryButtonText !== undefined && (
      <button type="button" className="kh-dialog__button" onClick={onSecondarySubmit ?? close}>{secondaryButtonText}</button>
    )}
    {primaryButtonText !== undefined && (
      <button type="button" className={`kh-dialog__button kh-dialog__button--${danger ? 'danger' : 'primary'}`}
        disabled={primaryButtonDisabled} onClick={() => { onRequestSubmit?.(); }}>{primaryButtonText}</button>
    )}
  </>;
  return (
    <AppDialog title={modalHeading} label={modalLabel}
      tone={danger ? 'danger' : 'info'} alert={danger} wide={size === undefined || size === 'md'} settings={size === 'lg'}
      className={className} actions={actions} onClose={close}>
      {children}
    </AppDialog>
  );
};
