import { useEffect } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { getDesktop } from '../types/desktop';
import { runDesktopCommand } from '../services/desktopCommands';
import { authSession } from '../services/authSession';

export function DesktopCommandReceiver(): null {
  const navigate = useNavigate();
  const location = useLocation();
  useEffect(() => getDesktop()?.onCommand?.(async request => {
    if (authSession.isExpired()) throw new Error('Sign in to Athena before using Stream Deck.');
    const target = request.command === 'speak' ? '/chat' : '/think';
    if (location.pathname !== target) navigate(target);
    await runDesktopCommand(request.command);
  }), [navigate, location.pathname]);
  return null;
}
