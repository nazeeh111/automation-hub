import React from 'react';
import './tokens.css';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import RecoveryBoundary from './RecoveryBoundary.jsx';
import './styles.css';
import './studio.css';

createRoot(document.getElementById('root')).render(<React.StrictMode><RecoveryBoundary nativeRoot><App /></RecoveryBoundary></React.StrictMode>);
