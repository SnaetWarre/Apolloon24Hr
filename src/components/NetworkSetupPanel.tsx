import React from 'react';

type NetAdapterProfile = {
  name: string;
  address: string;
  prefixLength: number | null;
  dhcp: boolean | null;
  connection: string | null;
};

type NetProfile = {
  platform: string;
  windows: boolean;
  elevateMethod: 'uac' | 'pkexec' | 'osascript' | null;
  elevateHint: string | null;
  manager: string | null;
  adapters: NetAdapterProfile[];
  primary: NetAdapterProfile | null;
  apipa: boolean;
  suggestion: { ip: string; prefixLength: number; gateway: string | null } | null;
  eventUrl: string | null;
  primaryWired: boolean | null;
  lastElevation: { id: string; state: 'waiting' | 'finished' | 'failed'; message: string | null } | null;
};

type Phase = 'idle' | 'confirm-make' | 'waiting-make' | 'confirm-revert' | 'waiting-revert';

const UNDO_PHRASE = 'VOORBIJ';

async function fetchProfile(): Promise<NetProfile> {
  const response = await fetch('/api/net/profile', { cache: 'no-store' });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const body = (await response.json()) as { ok: boolean; profile?: NetProfile; error?: string };
  if (!body.ok || !body.profile) throw new Error(body.error || 'Netwerkprofiel mislukt.');
  return body.profile;
}

export function NetworkSetupPanel() {
  const [profile, setProfile] = React.useState<NetProfile | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [phase, setPhase] = React.useState<Phase>('idle');
  const [ipInput, setIpInput] = React.useState('');
  const [gatewayInput, setGatewayInput] = React.useState('');
  const [eventOverChecked, setEventOverChecked] = React.useState(false);
  const [undoText, setUndoText] = React.useState('');
  const [message, setMessage] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const pollTimer = React.useRef<number | null>(null);

  const refresh = React.useCallback(async () => {
    try {
      const next = await fetchProfile();
      setProfile(next);
      setLoadError(null);
      return next;
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Netwerkprofiel mislukt.');
      return null;
    }
  }, []);

  React.useEffect(() => {
    void (async () => {
      const next = await refresh();
      if (next?.suggestion) {
        setIpInput((current) => current || next.suggestion!.ip);
        setGatewayInput((current) => current || next.suggestion!.gateway || '');
      }
      setLoading(false);
    })();
    return () => {
      if (pollTimer.current !== null) window.clearInterval(pollTimer.current);
    };
  }, [refresh]);

  const stopPolling = () => {
    if (pollTimer.current !== null) {
      window.clearInterval(pollTimer.current);
      pollTimer.current = null;
    }
  };

  /** Poll tot het adres echt vast (of terug automatisch) is, of de tijd om is. */
  const pollUntil = React.useCallback(
    (
      elevationId: string | null,
      done: (next: NetProfile) => boolean,
      onDone: () => void,
      onFailed: (message: string) => void,
      onTimeout: () => void
    ) => {
      stopPolling();
      let ticks = 0;
      // Only answers that name the address source count towards "nothing changed": a slow or
      // failed read (dhcp null) means still checking, not that the change did not happen.
      let answers = 0;
      const timer = window.setInterval(() => {
        ticks += 1;
        void (async () => {
          const next = await refresh();
          // A read can outlast the 2 s interval; one that ends after the poll stopped decides nothing.
          if (pollTimer.current !== timer) return;
          if (next?.primary && next.primary.dhcp !== null) answers += 1;
          const elevation = next?.lastElevation;
          if (next && done(next)) {
            stopPolling();
            onDone();
          } else if (elevationId && elevation?.id === elevationId && elevation.state === 'failed') {
            // The password prompt was refused or could not open; stop waiting right away.
            stopPolling();
            onFailed(elevation.message || 'De netwerkwijziging is mislukt. Er is niets veranderd.');
          } else if (answers >= 45) {
            stopPolling();
            onTimeout();
          } else if (ticks >= 90) {
            stopPolling();
            onFailed(
              'Dit toestel liet niet zien of het adres vast of automatisch is, dus het is niet zeker of het gelukt is. Herlaad deze pagina over een minuut om het na te kijken.'
            );
          }
        })();
      }, 2000);
      pollTimer.current = timer;
    },
    [refresh]
  );

  const startMakeStatic = async () => {
    setMessage(null);
    setError(null);
    try {
      const response = await fetch('/api/net/make-static', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          ip: ipInput.trim(),
          prefixLength: 24,
          gateway: gatewayInput.trim() || null,
        }),
      });
      const body = (await response.json()) as { ok: boolean; error?: string; elevationId?: string | null };
      if (!body.ok) {
        setError(body.error || 'Vastzetten mislukt.');
        setPhase('idle');
        return;
      }
      setPhase('waiting-make');
      const permissionHint = profile?.elevateHint || 'Het systeem vraagt nu om toestemming';
      setMessage(`${permissionHint} — bevestig op deze laptop en wacht op de melding “Gelukt!”…`);
      const wanted = ipInput.trim();
      pollUntil(
        body.elevationId ?? null,
        (next) => next.primary !== null && next.primary.address === wanted && next.primary.dhcp === false,
        () => {
          setPhase('idle');
          setMessage(
            `Gelukt! Dit adres is nu vast: ${wanted}. Andere apparaten blijven bereikbaar op http://${wanted}:5173.`
          );
        },
        (failure) => {
          setPhase('idle');
          setMessage(null);
          setError(failure);
        },
        () => {
          setPhase('idle');
          setError(
            'Er is niets veranderd. Waarschijnlijk is de toestemming geweigerd of weggeklikt. Probeer het opnieuw.'
          );
        }
      );
    } catch (err) {
      setPhase('idle');
      setError(err instanceof Error ? err.message : 'Vastzetten mislukt.');
    }
  };

  const startRevert = async () => {
    setMessage(null);
    setError(null);
    try {
      const response = await fetch('/api/net/revert-dhcp', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ eventOver: true, confirmText: undoText.trim().toUpperCase() }),
      });
      const body = (await response.json()) as { ok: boolean; error?: string; elevationId?: string | null };
      if (!body.ok) {
        setError(body.error || 'Terugzetten mislukt.');
        setPhase('idle');
        return;
      }
      setPhase('waiting-revert');
      const permissionHint = profile?.elevateHint || 'Het systeem vraagt nu om toestemming';
      setMessage(`${permissionHint} — bevestig op deze laptop en wacht op de melding “Gelukt!”…`);
      pollUntil(
        body.elevationId ?? null,
        (next) => next.primary !== null && next.primary.dhcp === true,
        () => {
          setPhase('idle');
          setEventOverChecked(false);
          setUndoText('');
          setMessage(
            'Gelukt! Dit toestel haalt zijn adres weer automatisch op. Vergeet niet ook de kabel eruit te halen als je naar school-wifi gaat.'
          );
        },
        (failure) => {
          setPhase('idle');
          setMessage(null);
          setError(failure);
        },
        () => {
          setPhase('idle');
          setError('Er is niets veranderd. Waarschijnlijk is de toestemming geweigerd of weggeklikt.');
        }
      );
    } catch (err) {
      setPhase('idle');
      setError(err instanceof Error ? err.message : 'Terugzetten mislukt.');
    }
  };

  if (loading) {
    return (
      <>
        <h2>Vast netwerkadres</h2>
        <p className="panel-copy">Bezig met opzoeken…</p>
      </>
    );
  }

  if (loadError || !profile) {
    return (
      <>
        <h2>Vast netwerkadres</h2>
        <div className="warning-banner" role="alert">
          Netwerkstatus kon niet geladen worden: {loadError || 'onbekende fout'}
        </div>
      </>
    );
  }

  const isStatic = profile.primary !== null && profile.primary.dhcp === false;
  const busy = phase === 'waiting-make' || phase === 'waiting-revert';

  return (
    <>
      <h2>Vast netwerkadres</h2>
      <p className="panel-copy">
        Deze stap doe je <strong>één keer per laptop, op die laptop zelf</strong>, met de netwerkkabel erin. Daarna
        verandert het adres nooit meer en blijven alle schermen werken.
      </p>

      {profile.apipa && (
        <div className="warning-banner" role="alert">
          Deze laptop heeft nu een noodadres (169.254.x.x): er is geen netwerk gevonden. Controleer dat de kabel in de
          switch zit en dat de switch aan staat.
        </div>
      )}

      {profile.primary && !profile.apipa && (
        <div className="host-hint">
          <span>
            <strong>Nu:</strong> {profile.primary.address} (adapter: {profile.primary.name}) ·{' '}
            {profile.primary.dhcp === null
              ? 'adresbron onbekend'
              : profile.primary.dhcp
                ? 'automatisch adres (kan veranderen!)'
                : 'vast adres (blijft staan!)'}
            {profile.eventUrl && (
              <>
                {' '}
                · Schermen verbinden met <strong>{profile.eventUrl}</strong>
              </>
            )}
          </span>
        </div>
      )}

      {profile.manager && (
        <div className="host-hint">
          <span>
            Beheerd door <strong>{profile.manager}</strong>.
          </span>
        </div>
      )}

      {!profile.elevateMethod && (
        <div className="host-hint">
          Automatisch vastzetten kan op dit toestel ({profile.platform}) niet vanuit de app. Doe het handmatig, of
          download hieronder het script voor de Windows- en Linux-laptops.
        </div>
      )}

      {profile.elevateMethod && !isStatic && (
        <>
          <p className="panel-copy">
            <strong>Stap 1:</strong> controleer het adres hieronder (meestal klopt wat er al staat).{' '}
            <strong>Stap 2:</strong> klik op de knop
            {profile.elevateHint ? (
              <>, bevestig ({profile.elevateHint.toLowerCase()})</>
            ) : (
              <>, bevestig de toestemmingsvraag</>
            )}{' '}
            en wacht op de melding <strong>“Gelukt!”</strong>. Herhaal dit op elke laptop met een ander adres.
          </p>
          {profile.primaryWired === false && (
            <div className="warning-banner">
              <span>
                <strong>Deze laptop is via wifi verbonden.</strong> Steek de netwerkkabel in: alleen een bedrade
                verbinding wordt vastgezet, zodat je wifi thuis of op school nooit verandert.
              </span>
            </div>
          )}
          <div className="form-row">
            <label>
              Vast adres voor deze laptop
              <input
                className="input"
                value={ipInput}
                onChange={(event) => setIpInput(event.target.value)}
                placeholder="192.168.1.211"
                inputMode="decimal"
                disabled={busy}
              />
            </label>
            <label>
              Gateway (alleen als er een router is, anders leeg laten)
              <input
                className="input"
                value={gatewayInput}
                onChange={(event) => setGatewayInput(event.target.value)}
                placeholder="192.168.1.1 of leeg"
                inputMode="decimal"
                disabled={busy}
              />
            </label>
          </div>
          {phase === 'confirm-make' ? (
            <div className="form-row form-row--plain">
              <button
                className="btn btn--primary"
                onClick={() => void startMakeStatic()}
                disabled={busy || !ipInput.trim()}
              >
                Ja, maak {ipInput.trim() || 'dit adres'} nu vast
              </button>
              <button className="btn btn--secondary" onClick={() => setPhase('idle')} disabled={busy}>
                Toch niet
              </button>
            </div>
          ) : (
            <button
              className="btn btn--primary"
              onClick={() => {
                setError(null);
                setMessage(null);
                setPhase('confirm-make');
              }}
              disabled={busy || !ipInput.trim() || profile.primaryWired === false}
            >
              {busy ? 'Bezig met controleren…' : 'Maak dit adres vast'}
            </button>
          )}
        </>
      )}

      {isStatic && profile.primary && (
        <div className="host-hint">
          <span>
            <strong>Dit adres staat vast:</strong> {profile.primary.address}. Goed zo — hier hoef je niets meer te doen
            tot het evenement voorbij is.
          </span>
        </div>
      )}

      {profile.elevateMethod && (
        <details className="host-hint">
          <summary className="disclosure">
            <span>
              <strong>Na het evenement: adres weer automatisch maken</strong> (hiervoor moet je twee keer bevestigen)
            </span>
          </summary>
          <p className="panel-copy">
            Zolang het adres vast staat, werkt school-wifi vaak <em>niet</em>. Zet het daarom na het evenement terug.
            Dit kan pas als je hieronder bevestigt dat het evenement echt voorbij is.
          </p>
          <label className="host-hint">
            <input
              type="checkbox"
              checked={eventOverChecked}
              onChange={(event) => setEventOverChecked(event.target.checked)}
              disabled={busy}
            />{' '}
            Het evenement is helemaal voorbij (echt waar).
          </label>
          <div className="form-row">
            <label>
              Typ {UNDO_PHRASE} om te bewijzen dat je het meent
              <input
                className="input"
                value={undoText}
                onChange={(event) => setUndoText(event.target.value.toUpperCase())}
                placeholder={UNDO_PHRASE}
                maxLength={16}
                disabled={busy}
              />
            </label>
          </div>
          {phase === 'confirm-revert' ? (
            <div className="form-row form-row--plain">
              <button
                className="btn btn--primary"
                onClick={() => void startRevert()}
                disabled={busy || !eventOverChecked || undoText.trim().toUpperCase() !== UNDO_PHRASE}
              >
                Ja, zet terug op automatisch
              </button>
              <button className="btn btn--secondary" onClick={() => setPhase('idle')} disabled={busy}>
                Toch niet
              </button>
            </div>
          ) : (
            <button
              className="btn btn--secondary"
              onClick={() => {
                setError(null);
                setMessage(null);
                setPhase('confirm-revert');
              }}
              disabled={busy || !eventOverChecked || undoText.trim().toUpperCase() !== UNDO_PHRASE}
              title={
                !eventOverChecked
                  ? 'Vink eerst aan dat het evenement voorbij is'
                  : undoText.trim().toUpperCase() !== UNDO_PHRASE
                    ? `Typ eerst ${UNDO_PHRASE}`
                    : 'Zet het adres terug op automatisch (DHCP)'
              }
            >
              Zet terug op automatisch
            </button>
          )}
        </details>
      )}

      <p className="panel-copy">
        Liever met de hand of op een andere laptop? Download:{' '}
        <a href="/event-network/Set-ApolloonStaticIp.ps1" download>
          Windows vastzetten-script
        </a>{' '}
        ·{' '}
        <a href="/event-network/set-apolloon-static-ip.sh" download>
          Linux/macOS vastzetten-script
        </a>{' '}
        ·{' '}
        <a href="/event-network/Test-ApolloonNetwork.ps1" download>
          controle-script (Windows)
        </a>{' '}
        ·{' '}
        <a href="/event-network/revert-apolloon-dhcp.sh" download>
          terugzetten-script (Linux/macOS)
        </a>{' '}
        ·{' '}
        <a href="/event-network/Revert-ApolloonDhcp.ps1" download>
          terugzetten-script (Windows)
        </a>
      </p>

      {message && (
        <div className="success-banner" role="status" aria-live="polite">
          {message}
        </div>
      )}
      {error && (
        <div className="warning-banner" role="alert">
          {error}
          {error.includes('alleen op de laptop zelf') && (
            <> Open Beheer op die laptop zelf (dus niet via het netwerk) en probeer het daar.</>
          )}
        </div>
      )}
    </>
  );
}
