/** Why the desktop app could not open, in words for the person in front of the laptop. */
export type StartupFailure =
  | { kind: 'server-exited'; exitCode: number | null; errorOutput: string; port: number }
  | { kind: 'server-timeout'; seconds: number; port: number }
  | { kind: 'screen'; detail: string };

export class StartupError extends Error {
  constructor(readonly failure: StartupFailure) {
    super(
      failure.kind === 'server-exited'
        ? `server stopped while starting (code ${failure.exitCode}): ${failure.errorOutput.match(/^\w*Error: .*$/m)?.[0] ?? 'no error message'}`
        : failure.kind === 'server-timeout'
          ? `server not ready after ${failure.seconds} s`
          : failure.detail
    );
    this.name = 'StartupError';
  }
}

export type StartupMessage = { message: string; detail: string };

const RESTART_HINT = 'Probeer opnieuw. Lukt het niet, herstart dan de laptop.';

export function describeStartupFailure(failure: StartupFailure, logPath: string): StartupMessage {
  const logLine = `Details staan in ${logPath}.`;
  switch (failure.kind) {
    case 'server-exited': {
      const output = failure.errorOutput;
      if (/EADDRINUSE|address already in use/i.test(output)) {
        return {
          message: `Poort ${failure.port} is al in gebruik.`,
          detail:
            `Een ander programma, of een tweede Apolloon die nog afsluit, gebruikt poort ${failure.port}. ` +
            `Sluit dat programma of wacht even, en probeer opnieuw.\n\n${logLine}`,
        };
      }
      if (/ENOSPC|SQLITE_FULL|disk is full|database or disk is full/i.test(output)) {
        return {
          message: 'De schijf van deze laptop is vol.',
          detail: `Maak ruimte vrij (bijvoorbeeld de map Downloads) en probeer opnieuw.\n\n${logLine}`,
        };
      }
      if (/EACCES|EPERM|SQLITE_READONLY|readonly database|permission denied/i.test(output)) {
        return {
          message: 'Apolloon mag niet in zijn eigen gegevensmap schrijven.',
          detail:
            'Een virusscanner of de rechten op de map houden dat tegen. Open de logmap om te zien welk bestand het is.' +
            `\n\n${logLine}`,
        };
      }
      if (/SQLITE_BUSY|database is locked/i.test(output)) {
        return {
          message: 'De databank is in gebruik door een ander programma.',
          detail: `Sluit andere vensters van Apolloon en programma's die de databank open hebben.\n\n${RESTART_HINT}\n\n${logLine}`,
        };
      }
      if (/SQLITE_CORRUPT|SQLITE_NOTADB|malformed|not a database/i.test(output)) {
        return {
          message: 'De databank op deze laptop is beschadigd.',
          detail:
            'Koppel deze laptop opnieuw aan de groep, of zet een backup terug. De automatische backups staan in de ' +
            `map backups in de logmap.\n\n${logLine}`,
        };
      }
      const reason = output.match(/^\w*Error: .*$/m)?.[0];
      return {
        message: 'De lokale server stopte tijdens het opstarten.',
        detail:
          `${RESTART_HINT}${reason ? `\n\nFoutmelding: ${reason}` : ''}` +
          `${failure.exitCode === null ? '' : ` (code ${failure.exitCode})`}\n\n${logLine}`,
      };
    }
    case 'server-timeout':
      return {
        message: `De lokale server reageerde niet binnen ${failure.seconds} seconden.`,
        detail:
          'Een trage of volle schijf, of een virusscanner die de databank controleert, kan dit vertragen. ' +
          `${RESTART_HINT}\n\n${logLine}`,
      };
    case 'screen':
      return {
        message: 'Het scherm van Apolloon kon niet worden geladen.',
        detail: `${failure.detail}\n\n${RESTART_HINT}\n\n${logLine}`,
      };
  }
}

/** Anything else that went wrong while opening, such as an unexpected exception. */
export function describeUnexpectedStartupError(error: unknown, logPath: string): StartupMessage {
  if (error instanceof StartupError) return describeStartupFailure(error.failure, logPath);
  const text = error instanceof Error ? error.message : String(error);
  return {
    message: 'Apolloon kon niet starten.',
    detail: `${RESTART_HINT}\n\nFoutmelding: ${text}\n\nDetails staan in ${logPath}.`,
  };
}
