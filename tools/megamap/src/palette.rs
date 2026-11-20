pub fn file_type_color(name: &str, binary: bool) -> [f32; 3] {
    if binary { [0.45, 0.45, 0.47] } else { hsv(ext_hue(name), 0.5, 0.8) }
}

pub fn ext_hue(name: &str) -> f32 {
    let ext = name.rsplit_once('.').map(|(_, e)| e).unwrap_or("");
    match ext {
        "rs" => 0.07,
        "clj" | "cljc" | "edn" => 0.33,
        "cljs" => 0.45,
        "js" | "mjs" | "jsx" => 0.14,
        "ts" | "tsx" => 0.58,
        "css" | "scss" => 0.78,
        "html" => 0.02,
        "json" | "toml" | "yaml" | "yml" => 0.5,
        "md" | "txt" => 0.62,
        _ => {
            let h = ext.bytes().fold(2166136261u32, |h, b| (h ^ b as u32).wrapping_mul(16777619));
            (h % 1000) as f32 / 1000.0
        }
    }
}

pub fn heat_color(heat: f32) -> [f32; 3] {
    if heat < 0.0 {
        return [0.30, 0.30, 0.32];
    }
    let stops = [(0.10, 0.22, 0.60), (0.62, 0.22, 0.62), (0.98, 0.45, 0.18), (1.0, 0.92, 0.35)];
    let t = heat.clamp(0.0, 1.0) * 3.0;
    let i = (t.floor() as usize).min(2);
    let f = t - i as f32;
    let (a, b) = (stops[i], stops[i + 1]);
    [a.0 + (b.0 - a.0) * f, a.1 + (b.1 - a.1) * f, a.2 + (b.2 - a.2) * f]
}

pub fn hsv(h: f32, s: f32, v: f32) -> [f32; 3] {
    let f = |n: f32| {
        let k = (n + h * 6.0) % 6.0;
        v - v * s * k.min(4.0 - k).clamp(0.0, 1.0)
    };
    [f(5.0), f(3.0), f(1.0)]
}
