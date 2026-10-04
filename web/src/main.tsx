import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import './estilos.css';

createRoot(document.getElementById('raiz')!).render(<StrictMode><App /></StrictMode>);
