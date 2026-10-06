import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import { instalarCoresDePartido } from './cores.ts';
import './estilos.css';

instalarCoresDePartido(); // variáveis --partido-* dos dois temas, antes do primeiro render
createRoot(document.getElementById('raiz')!).render(<StrictMode><App /></StrictMode>);

// PWA: instalável e com notificações push (o registro não bloqueia a primeira pintura)
if ('serviceWorker' in navigator) {
  addEventListener('load', () => { void navigator.serviceWorker.register('/sw.js'); });
}
