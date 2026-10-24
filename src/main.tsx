import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { initTauriBridge } from './tauriBridge';
import './styles.css';
import { applyTheme, loadTheme } from './theme';

applyTheme(loadTheme());
initTauriBridge();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
