use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{self, BufRead, Read, Write};
use std::net::{Ipv4Addr, SocketAddrV4, TcpStream};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, SyncSender};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::Duration;
use tungstenite::{Message, WebSocket};

const INSPECT: &str = include_str!(concat!(env!("OUT_DIR"), "/inspect-document.js"));
const MAX_FRAME: usize = 128 * 1024;
const MAX_TARGETS: usize = 32;
type Failure = &'static str;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Observation {
    id: u64,
    target_id: String,
    origins: Vec<String>,
}

#[derive(Serialize, Deserialize)]
struct Summary {
    text: String,
    details: Vec<Detail>,
}

#[derive(Serialize, Deserialize)]
struct Detail {
    role: String,
    name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    options: Option<Vec<SelectOption>>,
}

#[derive(Serialize, Deserialize)]
struct SelectOption {
    label: String,
    value: String,
}

fn expression(origins: &[String]) -> Result<String, Failure> {
    if origins.is_empty() || origins.len() > 256 {
        return Err("origin_denied");
    }
    for origin in origins {
        let host = origin
            .strip_prefix("https://")
            .or_else(|| origin.strip_prefix("http://"));
        if !host.is_some_and(|host| {
            !host.is_empty()
                && !host.contains(['/', '?', '#', '@'])
                && !host.chars().any(char::is_whitespace)
        }) {
            return Err("origin_denied");
        }
    }
    // JSON-encoded data is the only substitution from the caller.
    let origins = serde_json::to_string(origins).unwrap();
    let expression = format!(
        "(() => {{ const origins = {origins}; if (!origins.includes(self.origin) || !origins.includes(location.origin)) return null; return ({INSPECT})().summary; }})()"
    );
    Ok(expression)
}

fn summary(cdp: &mut Value) -> Result<Value, &'static str> {
    if cdp.get("exceptionDetails").is_some() {
        return Err("observation_failed");
    }
    let object = cdp.get_mut("result").ok_or("invalid_cdp_response")?;
    if object["type"] != "object" {
        return Err("invalid_cdp_response");
    }
    if object.get("value") == Some(&Value::Null) {
        return Err("origin_denied");
    }
    let data: Summary =
        serde_json::from_value(object["value"].take()).map_err(|_| "invalid_cdp_response")?;
    Ok(json!({"summary":data}))
}

struct Session {
    socket: WebSocket<TcpStream>,
    next: u64,
    context: Option<i64>,
}

impl Session {
    fn connect(port: u16, target: &str) -> Result<Self, Failure> {
        let address = SocketAddrV4::new(Ipv4Addr::LOCALHOST, port);
        let timeout = Duration::from_secs(10);
        let stream = TcpStream::connect_timeout(&address.into(), timeout)
            .map_err(|_| "target_unavailable")?;
        stream
            .set_read_timeout(Some(timeout))
            .map_err(|_| "target_unavailable")?;
        stream
            .set_write_timeout(Some(timeout))
            .map_err(|_| "target_unavailable")?;
        stream.set_nodelay(true).map_err(|_| "target_unavailable")?;
        let uri = format!("ws://{address}/devtools/page/{target}");
        let (socket, _) =
            tungstenite::client(uri.as_str(), stream).map_err(|_| "target_unavailable")?;
        Ok(Self {
            socket,
            next: 0,
            context: None,
        })
    }

    fn call(&mut self, method: &'static str, params: Value) -> Result<Value, Failure> {
        self.next += 1;
        let cmd = json!({"id":self.next,"method":method,"params":params});
        self.socket
            .send(Message::Text(cmd.to_string().into()))
            .map_err(|_| "target_unavailable")?;
        loop {
            let frame = self.socket.read().map_err(|_| "target_unavailable")?;
            if frame.is_close() {
                return Err("target_unavailable");
            }
            if let Message::Text(text) = frame {
                let mut reply: Value =
                    serde_json::from_str(&text).map_err(|_| "invalid_cdp_response")?;
                if reply["id"].as_u64() != Some(self.next) {
                    continue;
                }
                if reply.get("error").is_some() {
                    return Err("cdp_error");
                }
                return reply
                    .get_mut("result")
                    .map(Value::take)
                    .ok_or("invalid_cdp_response");
            }
        }
    }

    fn context(&mut self) -> Result<i64, Failure> {
        if let Some(context) = self.context {
            return Ok(context);
        }
        let tree = self.call("Page.getFrameTree", json!({}))?;
        let frame = tree
            .pointer("/frameTree/frame/id")
            .and_then(Value::as_str)
            .ok_or("invalid_cdp_response")?;
        let world = self.call(
            "Page.createIsolatedWorld",
            json!({"frameId":frame,"worldName":"open-browser-observer"}),
        )?;
        let context = world["executionContextId"]
            .as_i64()
            .ok_or("invalid_cdp_response")?;
        self.context = Some(context);
        Ok(context)
    }

    fn observe(&mut self, script: &str) -> Result<Value, Failure> {
        for attempt in 0..2 {
            let context = self.context()?;
            match self.call(
                "Runtime.evaluate",
                json!({"contextId":context,"expression":script,"returnByValue":true}),
            ) {
                Ok(mut result) => return summary(&mut result),
                Err("cdp_error") if attempt == 0 => self.context = None,
                Err(code) => return Err(code),
            }
        }
        unreachable!()
    }
}

struct Job {
    id: u64,
    script: String,
}

fn emit(id: Option<u64>, result: Result<Value, Failure>) -> io::Result<()> {
    let mut response = result.unwrap_or_else(|code| json!({"error":code}));
    response["id"] = json!(id);
    let mut output = io::stdout().lock();
    serde_json::to_writer(&mut output, &response)?;
    output.write_all(b"\n")?;
    output.flush()
}

type Slots = HashMap<String, (SyncSender<Job>, JoinHandle<()>)>;
type Workers = Arc<Mutex<Slots>>;

// Check for a racing enqueue while holding the very same lock used by dispatch.
// A sender either delivers to this receiver or sees the removed slot and starts a new one.
fn after_timeout(target: &str, queue: &Receiver<Job>, workers: &Workers) -> Option<Job> {
    let mut slots = workers.lock().unwrap();
    if let Ok(job) = queue.try_recv() {
        return Some(job);
    }
    slots.remove(target);
    None
}

fn worker(port: u16, target: String, queue: Receiver<Job>, workers: Workers, idle: Duration) {
    let mut session = None;
    loop {
        let job = match queue.recv_timeout(idle) {
            Ok(job) => job,
            Err(RecvTimeoutError::Timeout) => match after_timeout(&target, &queue, &workers) {
                Some(job) => job,
                None => break,
            },
            Err(RecvTimeoutError::Disconnected) => break,
        };
        let result = (|| {
            if session.is_none() {
                session = Some(Session::connect(port, &target)?);
            }
            session.as_mut().unwrap().observe(&job.script)
        })();
        if matches!(result, Err("target_unavailable")) {
            session = None;
        }
        if emit(Some(job.id), result).is_err() {
            break;
        }
    }
}

fn dispatch(port: u16, request: Observation, workers: &Workers) -> Result<(), Failure> {
    if request.id == 0
        || request.target_id.len() != 32
        || !request.target_id.bytes().all(|c| c.is_ascii_hexdigit())
    {
        return Err("invalid_request");
    }
    let script = expression(&request.origins)?;
    let target = request.target_id.to_ascii_uppercase();
    let mut slots = workers.lock().unwrap();
    if !slots.contains_key(&target) {
        if slots.len() >= MAX_TARGETS {
            return Err("observer_busy");
        }
        let (tx, rx) = mpsc::sync_channel(32);
        let name = target.clone();
        let registry = Arc::clone(workers);
        let join = thread::spawn(move || worker(port, name, rx, registry, Duration::from_secs(15)));
        slots.insert(target.clone(), (tx, join));
    }
    slots[&target]
        .0
        .try_send(Job {
            id: request.id,
            script,
        })
        .map_err(|_| "observer_busy")
}

fn main() -> io::Result<()> {
    let port = std::env::args()
        .nth(1)
        .and_then(|value| value.parse::<u16>().ok())
        .filter(|value| *value > 0)
        .ok_or(io::Error::new(
            io::ErrorKind::InvalidInput,
            "expected loopback port",
        ))?;
    let workers = Workers::default();
    let mut input = io::stdin().lock();
    let mut buffer = Vec::new();
    loop {
        buffer.clear();
        let count = (&mut input)
            .take((MAX_FRAME + 1) as u64)
            .read_until(b'\n', &mut buffer)?;
        if count == 0 {
            break;
        }
        if count > MAX_FRAME {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "frame_too_large",
            ));
        }
        let frame: Value = serde_json::from_slice(&buffer).unwrap_or(Value::Null);
        let id = frame.get("id").and_then(Value::as_u64);
        let result = serde_json::from_value(frame)
            .map_err(|_| "invalid_request")
            .and_then(|job| dispatch(port, job, &workers));
        if let Err(code) = result {
            emit(id, Err(code))?;
        }
    }
    let slots = std::mem::take(&mut *workers.lock().unwrap());
    for (_, (queue, join)) in slots {
        drop(queue);
        let _ = join.join();
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn all_idle_workers_retire_and_make_room_for_a_new_target() {
        let workers = Workers::default();
        let (done, retired) = mpsc::channel();
        let mut slots = workers.lock().unwrap();
        for i in 0..MAX_TARGETS {
            let (tx, rx) = mpsc::sync_channel(1);
            let key = format!("{i:032X}");
            let target = key.clone();
            let registry = Arc::clone(&workers);
            let done = done.clone();
            let handle = thread::spawn(move || {
                worker(1, target, rx, registry, Duration::from_millis(2));
                done.send(()).unwrap();
            });
            slots.insert(key, (tx, handle));
        }
        assert_eq!(slots.len(), MAX_TARGETS);
        drop(slots);
        for _ in 0..MAX_TARGETS {
            retired.recv_timeout(Duration::from_secs(3)).unwrap();
        }
        assert!(workers.lock().unwrap().is_empty());
    }

    #[test]
    fn enqueue_during_timeout_is_processed_once_and_in_order() {
        let workers = Workers::default();
        let (tx, rx) = mpsc::sync_channel(2);
        let target = "A".repeat(32);
        let idle = thread::spawn(|| {});
        workers.lock().unwrap().insert(target.clone(), (tx, idle));
        for id in [11, 12] {
            dispatch(
                1,
                Observation {
                    id,
                    target_id: target.clone(),
                    origins: vec!["http://localhost".into()],
                },
                &workers,
            )
            .unwrap();
        }
        assert_eq!(after_timeout(&target, &rx, &workers).unwrap().id, 11);
        assert_eq!(rx.try_recv().unwrap().id, 12);
        assert!(after_timeout(&target, &rx, &workers).is_none());
        assert!(workers.lock().unwrap().is_empty());
    }

    #[test]
    fn no_remote_handles_or_extra_fields() {
        let mut result = json!({"result":{"type":"object","value":{"text":"ready","nodes":["handle"],
            "details":[{"role":"button","name":"OK","ref":"a1"}]}}});
        assert_eq!(
            summary(&mut result).unwrap(),
            json!({"summary":{"text":"ready","details":[{"role":"button","name":"OK"}]}})
        );
        assert_eq!(
            summary(&mut json!({"result":{"type":"object","value":null}})),
            Err("origin_denied")
        );
    }
    #[test]
    fn accepts_only_observation_requests_and_valid_target_paths() {
        assert!(serde_json::from_value::<Observation>(
            json!({"id":1,"targetId":"x","origins":[],"expression":"alert()"})
        )
        .is_err());
        let request = Observation {
            id: 1,
            target_id: "../../other".to_owned(),
            origins: vec!["https://example.test".to_owned()],
        };
        assert_eq!(
            dispatch(1, request, &Workers::default()),
            Err("invalid_request")
        );
        assert_eq!(expression(&["null".to_owned()]), Err("origin_denied"));
        assert!(expression(&["http://127.0.0.1:1234".to_owned()])
            .unwrap()
            .contains(INSPECT));
    }
}
