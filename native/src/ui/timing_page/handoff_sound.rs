const SAMPLE_RATE: u32 = 24_000;

fn samples() -> Vec<f32> {
    let frames = SAMPLE_RATE * 55 / 1_000;
    (0..frames)
        .map(|i| {
            let seconds = i as f32 / SAMPLE_RATE as f32;
            let attack = (seconds / 0.003).min(1.0);
            let decay = (1.0 - i as f32 / frames as f32).powi(3);
            0.16 * attack * decay * (std::f32::consts::TAU * 880.0 * seconds).sin()
        })
        .collect()
}

#[derive(Default)]
pub(super) struct Click {
    enabled: bool,
    #[cfg(target_arch = "wasm32")]
    context: Option<web_sys::AudioContext>,
}

impl Click {
    pub(super) fn enabled(&self) -> bool {
        self.enabled
    }

    pub(super) fn toggle(&mut self) {
        if self.enabled {
            self.enabled = false;
            return;
        }
        #[cfg(target_arch = "wasm32")]
        {
            // Browsers need a user gesture before audio can start.
            if self.context.is_none() {
                self.context = web_sys::AudioContext::new().ok();
            }
            let Some(context) = &self.context else { return };
            if let Ok(resume) = context.resume() {
                wasm_bindgen_futures::spawn_local(async move {
                    let _ = wasm_bindgen_futures::JsFuture::from(resume).await;
                });
            }
        }
        self.enabled = true;
    }

    pub(super) fn play(&self) {
        if !self.enabled {
            return;
        }
        #[cfg(target_arch = "wasm32")]
        if let Some(context) = &self.context
            && context.state() == web_sys::AudioContextState::Running
        {
            let _ = play_web(context);
        }
        #[cfg(not(target_arch = "wasm32"))]
        {
            // Opening an output device must not hold up the lap clock or the UI.
            let _ = std::thread::Builder::new()
                .name("handoff-click".into())
                .spawn(|| {
                    let Ok(mut stream) = rodio::OutputStreamBuilder::open_default_stream() else {
                        return;
                    };
                    stream.log_on_drop(false);
                    let sink = rodio::Sink::connect_new(stream.mixer());
                    sink.append(rodio::buffer::SamplesBuffer::new(1, SAMPLE_RATE, samples()));
                    // Leave time for device buffers to drain, even if playback stops reporting progress.
                    std::thread::sleep(std::time::Duration::from_millis(250));
                });
        }
    }
}

#[cfg(target_arch = "wasm32")]
fn play_web(context: &web_sys::AudioContext) -> Result<(), wasm_bindgen::JsValue> {
    let samples = samples();
    let buffer = context.create_buffer(1, samples.len() as u32, SAMPLE_RATE as f32)?;
    buffer.copy_to_channel(&samples, 0)?;
    let source = context.create_buffer_source()?;
    source.set_buffer(Some(&buffer));
    source.connect_with_audio_node(&context.destination())?;
    source.start()
}
