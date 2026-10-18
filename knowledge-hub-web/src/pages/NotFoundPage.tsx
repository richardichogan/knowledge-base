import React from 'react';
import { Link } from 'react-router-dom';
import styles from './Page.module.css';

export const NotFoundPage: React.FC = () => (
  <main className={styles.state}>
    <h1 className={styles.stateTitle}>Page not found.</h1>
    <Link to="/">← Back to Today</Link>
  </main>
);
