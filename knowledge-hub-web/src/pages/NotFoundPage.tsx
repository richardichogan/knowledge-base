import React from 'react';
import { Link } from 'react-router-dom';
import styles from './Page.module.css';

export const NotFoundPage: React.FC = () => (
  <div className={styles.state}>
    <p style={{ fontSize: 18, marginBottom: 12 }}>Page not found.</p>
    <Link to="/">← Back to Timeline</Link>
  </div>
);
