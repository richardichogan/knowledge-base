import React from 'react';

interface PageHeaderProps {
  title: string;
  subtitle?: React.ReactNode;
  actions?: React.ReactNode;
  className?: string;
}

export function PageHeader({ title, subtitle, actions, className }: PageHeaderProps): React.ReactElement {
  return (
    <header className={`page-header kh-page-header${className ? ` ${className}` : ''}`}>
      <div className="page-title-group">
        <h1 className="page-title">{title}</h1>
        {subtitle != null && <p className="page-subtitle">{subtitle}</p>}
      </div>
      {actions != null && <div className="kh-page-header__actions kh-command-row">{actions}</div>}
    </header>
  );
}
