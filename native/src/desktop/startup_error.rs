//! Port of electron/startup-error.ts: why the app could not open, in words for the person
//! in front of the laptop.
#[derive(Clone, Debug, PartialEq)]
pub enum StartupFailure {
    ServerExited {
        exit_code: Option<i32>,
        error_output: String,
        port: u16,
    },
    ServerTimeout {
        seconds: u64,
        port: u16,
    },
    Screen {
        detail: String,
    },
    Other {
        text: String,
    },
}

#[derive(Clone, Debug, PartialEq)]
pub struct StartupMessage {
    pub message: String,
    pub detail: String,
}

const RESTART_HINT: &str = "Probeer opnieuw. Lukt het niet, herstart dan de laptop.";

/// The first `SomethingError: …` line (Node), or the native server's `Apolloon: …` line.
pub fn error_line(output: &str) -> Option<&str> {
    output.lines().find(|line| {
        if line.starts_with("Apolloon: ") {
            return true;
        }
        line.find("Error: ")
            .is_some_and(|i| line[..i].chars().all(|c| c.is_alphanumeric() || c == '_'))
    })
}

fn any(output: &str, needles: &[&str]) -> bool {
    let lower = output.to_lowercase();
    needles.iter().any(|n| lower.contains(&n.to_lowercase()))
}

impl std::fmt::Display for StartupFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::ServerExited {
                exit_code,
                error_output,
                ..
            } => write!(
                f,
                "server stopped while starting (code {}): {}",
                exit_code.map(|c| c.to_string()).unwrap_or("null".into()),
                error_line(error_output).unwrap_or("no error message")
            ),
            Self::ServerTimeout { seconds, .. } => write!(f, "server not ready after {seconds} s"),
            Self::Screen { detail } => f.write_str(detail),
            Self::Other { text } => f.write_str(text),
        }
    }
}

pub fn describe(failure: &StartupFailure, log_path: &str) -> StartupMessage {
    let log_line = format!("Details staan in {log_path}.");
    let m = |message: String, detail: String| StartupMessage { message, detail };
    match failure {
        StartupFailure::ServerExited {
            exit_code,
            error_output: output,
            port,
        } => {
            if any(
                output,
                &[
                    "EADDRINUSE",
                    "address already in use",
                    "address in use",
                    "os error 98",
                    "os error 10048",
                    "os error 48",
                ],
            ) {
                return m(
                    format!("Poort {port} is al in gebruik."),
                    format!(
                        "Een ander programma, of een tweede Apolloon die nog afsluit, gebruikt poort {port}. Sluit dat programma of wacht even, en probeer opnieuw.\n\n{log_line}"
                    ),
                );
            }
            if any(
                output,
                &[
                    "could not be put aside",
                    "niet veilig opzij",
                    "SQLITE_CORRUPT",
                    "SQLITE_NOTADB",
                    "malformed",
                    "not a database",
                ],
            ) {
                return m(
                    "De databank op deze laptop is beschadigd en kon niet opzij gezet worden."
                        .into(),
                    format!(
                        "Apolloon zet een beschadigde databank zelf opzij en start dan met een lege. Dat lukte nu niet, misschien omdat een virusscanner of een ander programma het bestand vasthoudt. Sluit andere programma's en probeer opnieuw. Lukt het niet, open dan de logmap en verplaats app.db uit de map data naar een andere map. Laat de map backups staan.\n\n{log_line}"
                    ),
                );
            }
            if any(
                output,
                &[
                    "ENOSPC",
                    "SQLITE_FULL",
                    "disk is full",
                    "database or disk is full",
                    "no space left",
                ],
            ) {
                return m(
                    "De schijf van deze laptop is vol.".into(),
                    format!(
                        "Maak ruimte vrij (bijvoorbeeld de map Downloads) en probeer opnieuw.\n\n{log_line}"
                    ),
                );
            }
            if any(
                output,
                &[
                    "EACCES",
                    "EPERM",
                    "SQLITE_READONLY",
                    "readonly database",
                    "permission denied",
                ],
            ) {
                return m(
                    "Apolloon mag niet in zijn eigen gegevensmap schrijven.".into(),
                    format!(
                        "Een virusscanner of de rechten op de map houden dat tegen. Open de logmap om te zien welk bestand het is.\n\n{log_line}"
                    ),
                );
            }
            if any(output, &["SQLITE_BUSY", "database is locked"]) {
                return m(
                    "De databank is in gebruik door een ander programma.".into(),
                    format!(
                        "Sluit andere vensters van Apolloon en programma's die de databank open hebben.\n\n{RESTART_HINT}\n\n{log_line}"
                    ),
                );
            }
            let reason = error_line(output)
                .map(|r| format!("\n\nFoutmelding: {r}"))
                .unwrap_or_default();
            let code = exit_code
                .map(|c| format!(" (code {c})"))
                .unwrap_or_default();
            m(
                "De lokale server stopte tijdens het opstarten.".into(),
                format!("{RESTART_HINT}{reason}{code}\n\n{log_line}"),
            )
        }
        StartupFailure::ServerTimeout { seconds, .. } => m(
            format!("De lokale server reageerde niet binnen {seconds} seconden."),
            format!(
                "Een trage of volle schijf, of een virusscanner die de databank controleert, kan dit vertragen. {RESTART_HINT}\n\n{log_line}"
            ),
        ),
        StartupFailure::Screen { detail } => m(
            "Het scherm van Apolloon kon niet worden geladen.".into(),
            format!("{detail}\n\n{RESTART_HINT}\n\n{log_line}"),
        ),
        StartupFailure::Other { text } => m(
            "Apolloon kon niet starten.".into(),
            format!("{RESTART_HINT}\n\nFoutmelding: {text}\n\n{log_line}"),
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn exited(output: &str) -> StartupMessage {
        describe(
            &StartupFailure::ServerExited {
                exit_code: Some(1),
                error_output: output.into(),
                port: 5173,
            },
            "/x/server.log",
        )
    }
    #[test]
    fn known_causes_get_their_own_advice() {
        assert_eq!(
            exited("Apolloon: Serverpoort 5173: Address already in use (os error 98)").message,
            "Poort 5173 is al in gebruik."
        );
        assert!(
            exited("SqliteFailure: database disk image is malformed")
                .message
                .contains("beschadigd")
        );
        assert_eq!(
            exited("No space left on device").message,
            "De schijf van deze laptop is vol."
        );
        assert!(
            exited("Permission denied (os error 13)")
                .message
                .contains("niet in zijn eigen gegevensmap")
        );
        assert!(exited("database is locked").message.contains("in gebruik"));
        let other = exited("noise\nTypeError: boom\n");
        assert_eq!(
            other.message,
            "De lokale server stopte tijdens het opstarten."
        );
        assert!(
            other
                .detail
                .contains("Foutmelding: TypeError: boom (code 1)")
        );
        assert!(other.detail.ends_with("Details staan in /x/server.log."));
        let timeout = describe(
            &StartupFailure::ServerTimeout {
                seconds: 20,
                port: 1,
            },
            "l",
        );
        assert_eq!(
            timeout.message,
            "De lokale server reageerde niet binnen 20 seconden."
        );
    }
}
