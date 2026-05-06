/**
 * features/autocue/AutocueApp.tsx
 * Top-level route component for /autocue and /autocue/:noteId.
 * Renders outside the main AppShell — no nav, no header.
 */

import React from 'react';
import { Routes, Route } from 'react-router-dom';
import { ScriptSelector } from './ScriptSelector';
import { AutocueSession } from './AutocueSession';
import './autocue.css';

export const AutocueApp: React.FC = () => {
  return (
    <div className="ac-root">
      <Routes>
        <Route index element={<ScriptSelector />} />
        <Route path=":noteId" element={<AutocueSession />} />
      </Routes>
    </div>
  );
};
