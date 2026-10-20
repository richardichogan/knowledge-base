import React from 'react';
import { Link } from 'react-router-dom';

export function PeopleMessageText({ text }: { text: string }): React.ReactElement {
  const parts: React.ReactNode[] = [];
  let from = 0;
  for (const match of text.matchAll(/@\[([^\]\r\n]*)\]\((\/(?:people\?personId|projects\?projectId|think\?noteId|library\?contentItemId)=[^)\s]+)\)/g)) {
    parts.push(text.slice(from, match.index));
    parts.push(<Link className="people-message-mention" key={match.index} to={match[2]!}>@{match[1]}</Link>);
    from = match.index + match[0].length;
  }
  parts.push(text.slice(from));
  return <>{parts}</>;
}
