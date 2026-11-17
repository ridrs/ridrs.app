use std::io::{BufRead, BufReader, Read};
use std::os::unix::process::CommandExt;
use std::process::{Child, Command, Stdio};

/// Spawn in its own process group (the child is the group leader), stdout and stderr piped.
pub fn spawn_group(cmd: &mut Command) -> std::io::Result<Child> {
    cmd.process_group(0).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn()
}

pub fn kill_group(pgid: i32, sig: i32) {
    if pgid > 1 {
        unsafe {
            libc::killpg(pgid, sig);
        }
    }
}

pub fn group_alive(pgid: i32) -> bool {
    pgid > 1 && unsafe { libc::killpg(pgid, 0) } == 0
}

/// Read lines (also handles progress output that ends in \r) and hand each to `f`.
pub fn read_lines<R: Read>(r: R, mut f: impl FnMut(String)) {
    let mut br = BufReader::new(r);
    let mut buf = Vec::new();
    loop {
        buf.clear();
        match br.read_until(b'\n', &mut buf) {
            Ok(0) | Err(_) => break,
            Ok(_) => {
                let s = String::from_utf8_lossy(&buf).to_string();
                for part in s.split('\r') {
                    let t = part.trim_end_matches(['\n', '\r']);
                    if !t.is_empty() {
                        f(t.to_string());
                    }
                }
            }
        }
    }
}
