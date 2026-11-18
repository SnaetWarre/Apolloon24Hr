//! Watch the GUI process independently of the timing server. Time out only after the Rune event
//! loop has reported its first pulse. Two missed intervals match the Electron recovery delay.
use std::{
    io::{BufRead, BufReader, Read, Write},
    process::ChildStdout,
    sync::mpsc::{self, Receiver, RecvTimeoutError},
    time::Duration,
};

const PULSE: &[u8] = b"apolloon-window-pulse\n";
const INTERVAL: Duration = Duration::from_secs(5);

#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum Signal {
    Pulse,
    Quit,
    Lost,
}

pub(super) fn send_attached_pulse() {
    let mut output = std::io::stdout().lock();
    let _ = output.write_all(PULSE).and_then(|()| output.flush());
}

pub(super) fn parent_signals() -> Receiver<Signal> {
    let (send, receive) = mpsc::channel();
    std::thread::spawn(move || {
        for byte in BufReader::new(std::io::stdin().lock())
            .bytes()
            .map_while(Result::ok)
        {
            let signal = match byte {
                b'h' => Signal::Pulse,
                b'q' => Signal::Quit,
                _ => continue,
            };
            if send.send(signal).is_err() || signal == Signal::Quit {
                break;
            }
        }
    });
    receive
}

pub(super) fn attached_signals(output: ChildStdout) -> Receiver<Signal> {
    let (send, receive) = mpsc::channel();
    std::thread::spawn(move || {
        for line in BufReader::new(output).split(b'\n').map_while(Result::ok) {
            if line.as_slice() == &PULSE[..PULSE.len() - 1] && send.send(Signal::Pulse).is_err() {
                break;
            }
        }
    });
    receive
}

pub(super) fn observe(signals: Receiver<Signal>, mut terminate: impl FnMut() -> bool) -> Signal {
    match signals.recv() {
        Ok(Signal::Pulse) => {}
        Ok(other) => return other,
        Err(_) => return Signal::Lost,
    }
    let mut missed = 0;
    loop {
        match signals.recv_timeout(INTERVAL) {
            Ok(Signal::Pulse) => missed = 0,
            Ok(other) => return other,
            Err(RecvTimeoutError::Disconnected) => return Signal::Lost,
            Err(RecvTimeoutError::Timeout) => {
                missed += 1;
                if missed >= 2 && terminate() {
                    return Signal::Lost;
                }
            }
        }
    }
}

#[cfg(unix)]
pub(super) struct ParentWindow(u32);

#[cfg(unix)]
impl ParentWindow {
    pub(super) fn open(pid: u32) -> Self {
        ParentWindow(pid)
    }

    pub(super) fn terminate(&self) -> bool {
        let Ok(pid) = libc::pid_t::try_from(self.0) else {
            return false;
        };
        // The server is a direct child of the window. Never signal an unrelated PID.
        unsafe { pid > 1 && libc::getppid() == pid && libc::kill(pid, libc::SIGKILL) == 0 }
    }
}

#[cfg(windows)]
pub(super) struct ParentWindow(windows_sys::Win32::Foundation::HANDLE);

#[cfg(windows)]
impl ParentWindow {
    pub(super) fn open(pid: u32) -> Self {
        use windows_sys::Win32::System::Threading::{OpenProcess, PROCESS_TERMINATE};
        // Holding the handle keeps the process identity stable if the PID is reused.
        Self(unsafe { OpenProcess(PROCESS_TERMINATE, 0, pid) })
    }

    pub(super) fn terminate(&self) -> bool {
        use windows_sys::Win32::System::Threading::TerminateProcess;
        !self.0.is_null() && unsafe { TerminateProcess(self.0, 1) != 0 }
    }
}

#[cfg(windows)]
impl Drop for ParentWindow {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe { windows_sys::Win32::Foundation::CloseHandle(self.0) };
        }
    }
}
