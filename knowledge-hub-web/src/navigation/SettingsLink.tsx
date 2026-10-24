import React from 'react';
import { Link, useLocation, type LinkProps } from 'react-router-dom';
import { settingsLinkState } from './settings';

export function SettingsLink(props: Omit<LinkProps, 'state'>): React.ReactElement {
  const location = useLocation();
  return <Link {...props} state={settingsLinkState(location)} />;
}
