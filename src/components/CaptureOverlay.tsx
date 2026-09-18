import React from 'react';
import { IonButton } from '@ionic/react';

/**
 * Barre de capture affichée sous la prévisualisation native
 * (même position que l'overlay vidéo : bandeau bas fixe).
 */
const CaptureOverlay: React.FC<{
  busy: boolean;
  hint?: string;
  snapLabel?: string;
  onSnap: () => void;
  onCancel: () => void;
}> = ({ busy, hint, snapLabel = '📷 Capturer', onSnap, onCancel }) => (
  <div className="film-overlay">
    {hint ? <p style={{ margin: '0 0 8px' }}>{hint}</p> : null}
    <div style={{ display: 'flex', gap: 8, justifyContent: 'center' }}>
      <IonButton size="large" onClick={onSnap} disabled={busy}>
        {snapLabel}
      </IonButton>
      <IonButton fill="outline" onClick={onCancel}>
        Annuler
      </IonButton>
    </div>
  </div>
);

export default CaptureOverlay;
