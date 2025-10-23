import React from 'react';

interface ConnectionInfoModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export const ConnectionInfoModal: React.FC<ConnectionInfoModalProps> = ({ isOpen, onClose }) => {
  if (!isOpen) return null;

  return (
    <div 
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        backgroundColor: 'rgba(0, 0, 0, 0.5)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 1000,
      }}
      onClick={onClose}
    >
      <div 
        style={{
          backgroundColor: 'white',
          padding: '32px',
          borderRadius: '8px',
          maxWidth: '600px',
          width: '90%',
          boxShadow: '0 4px 20px rgba(0, 0, 0, 0.2)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <h2 style={{ marginTop: 0, marginBottom: '24px', fontSize: '24px' }}>
          Verbinden met een ander apparaat
        </h2>
        
        <div style={{ marginBottom: '24px' }}>
          <p style={{ marginBottom: '16px', fontSize: '16px' }}>
            Om dit systeem te gebruiken vanaf een ander apparaat (zoals een tablet of laptop):
          </p>
          
          <ol style={{ fontSize: '16px', lineHeight: '1.8', paddingLeft: '24px' }}>
            <li>Zorg dat het andere apparaat verbonden is met <strong>hetzelfde netwerk/router</strong></li>
            <li>Open een webbrowser op dat apparaat</li>
            <li>Ga naar het volgende adres:</li>
          </ol>
          
          <div 
            style={{
              backgroundColor: '#f5f5f5',
              padding: '16px',
              borderRadius: '4px',
              marginTop: '16px',
              marginBottom: '16px',
              fontFamily: 'monospace',
              fontSize: '20px',
              fontWeight: 'bold',
              textAlign: 'center',
              border: '2px solid #333',
            }}
          >
            http://telsysteem2.local:5173
          </div>
          
          <p style={{ fontSize: '14px', color: '#666', marginTop: '16px' }}>
            <strong>Let op:</strong> Beide apparaten moeten op hetzelfde lokale netwerk aangesloten zijn. 
            Het IP-adres van deze laptop kan wijzigen, maar het bovenstaande adres blijft altijd hetzelfde werken.
          </p>
        </div>
        
        <button 
          onClick={onClose}
          className="btn btn--primary"
          style={{ width: '100%', padding: '12px', fontSize: '16px' }}
        >
          Sluiten
        </button>
      </div>
    </div>
  );
};

