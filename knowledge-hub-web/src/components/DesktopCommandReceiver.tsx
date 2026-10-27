import { useEffect } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { getDesktop } from '../types/desktop';
import { runDesktopCommand } from '../services/desktopCommands';
import { authSession } from '../services/authSession';
import { useAthenaContext } from '../context/AthenaContext';

export function DesktopCommandReceiver(): null {
  const navigate = useNavigate();
  const location = useLocation();
  const { launchAthena, hasEmbeddedAthena } = useAthenaContext();
  useEffect(() => getDesktop()?.onCommand?.(async request => {
    if (authSession.isExpired()) throw new Error('Sign in to Athena before using Stream Deck.');
    if (request.command === 'speak') {
      if (location.pathname === '/chat') throw new Error('Open the main Athena workspace before using Speak.');
      if (location.pathname === '/think' && !hasEmbeddedAthena) throw new Error('Open a note or canvas in Think before speaking to Athena.');
      launchAthena();
    } else if (location.pathname !== '/think') navigate('/think');
    await runDesktopCommand(request.command);
  }), [navigate, location.pathname, launchAthena, hasEmbeddedAthena]);
  return null;
}
