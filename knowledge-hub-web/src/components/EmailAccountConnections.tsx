import React from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../services/api';

export const EmailAccountConnections: React.FC = () => {
  const query = useQuery({
    queryKey: ['email-account-connections'],
    queryFn: async () => {
      const response = await api.getEmailAccountConnections();
      if (!response.success) throw new Error(response.error.message);
      return response.data;
    },
    staleTime: 30_000,
  });
  return (
    <section className="email-connections" aria-labelledby="email-connections-title">
      <h3 id="email-connections-title">Email accounts</h3>
      <p className="email-connections__intro">Accounts to connect. Adding an address does not authorise access or start importing mail.</p>
      {query.isPending && <p role="status">Loading email accounts...</p>}
      {query.isError && <p className="email-connections__error" role="alert">Email accounts could not be loaded.
        <button type="button" onClick={() => { void query.refetch(); }}>Retry</button></p>}
      <div className="email-connections__list">
        {query.data?.map((account) => (
          <article key={account.id} className="email-connections__account">
            <div className="email-connections__heading">
              <span className="email-connections__address">{account.email}</span>
              <span className={`email-connections__status email-connections__status--${account.status}`}>
                {account.status === 'configured' ? 'Configured, access not verified' : 'Not connected'}
              </span>
            </div>
            <p className="email-connections__provider">{account.provider}</p>
            <p>{account.detail}</p>
          </article>
        ))}
      </div>
    </section>
  );
};
