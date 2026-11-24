import React, { useEffect, useState } from 'react';
import './jpti-splash.css';

const SPLASH_DURATION_MS = 15000;

export default function JPTISplash() {
  const [visible, setVisible] = useState(true);

  useEffect(() => {
    const timer = window.setTimeout(() => setVisible(false), SPLASH_DURATION_MS);
    return () => window.clearTimeout(timer);
  }, []);

  if (!visible) return null;

  return (
    <div className="jpti-splash" role="status" aria-live="polite" aria-label="Jopearl Trading Intelligence loading">
      <div className="jpti-splash-orbit jpti-splash-orbit-one" />
      <div className="jpti-splash-orbit jpti-splash-orbit-two" />
      <div className="jpti-splash-card">
        <div className="jpti-splash-icon-wrap">
          <img className="jpti-splash-icon" src={`${import.meta.env.BASE_URL}jpti-icon.svg`} alt="" />
          <span className="jpti-splash-pulse" />
        </div>
        <div className="jpti-splash-wordmark">JOPEARL</div>
        <div className="jpti-splash-subtitle">TRADING INTELLIGENCE</div>
        <div className="jpti-splash-tagline">INTELLIGENCE · PRECISION · CONTROL</div>
        <div className="jpti-splash-loader"><span /></div>
        <div className="jpti-splash-status">INITIALIZING TRADING ENVIRONMENT</div>
      </div>
      <span className="jpti-splash-corner jpti-splash-corner-tl" />
      <span className="jpti-splash-corner jpti-splash-corner-br" />
    </div>
  );
}
