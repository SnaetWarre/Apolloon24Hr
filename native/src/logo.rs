//! Decode, trim transparent margins and fit uploaded logos to 256 pixels.
use crate::db::Result;
use image::{DynamicImage, GenericImageView, ImageFormat};
use std::io::Cursor;
fn fit(image: DynamicImage, max: u32) -> DynamicImage {
    let scale = (max as f64 / image.width().max(image.height()) as f64).min(1.0);
    if scale >= 1.0 {
        return image;
    }
    let width = (image.width() as f64 * scale).round().max(1.0) as u32;
    let height = (image.height() as f64 * scale).round().max(1.0) as u32;
    image.resize_exact(width, height, image::imageops::FilterType::Lanczos3)
}
pub fn prepare(bytes: &[u8]) -> Result<Vec<u8>> {
    let image = if bytes
        .iter()
        .take(1024)
        .copied()
        .collect::<Vec<_>>()
        .windows(4)
        .any(|w| w == b"<svg")
    {
        let tree = resvg::usvg::Tree::from_data(bytes, &resvg::usvg::Options::default())
            .map_err(|_| "Geen leesbare afbeelding")?;
        let size = tree.size();
        let scale = 1024.0 / size.width().max(size.height());
        let width = (size.width() * scale).round().max(1.0) as u32;
        let height = (size.height() * scale).round().max(1.0) as u32;
        let mut pixels =
            resvg::tiny_skia::Pixmap::new(width, height).ok_or("Logo verkleinen mislukt")?;
        resvg::render(
            &tree,
            resvg::tiny_skia::Transform::from_scale(scale, scale),
            &mut pixels.as_mut(),
        );
        let mut rgba = pixels.take();
        for p in rgba.chunks_exact_mut(4) {
            let alpha = p[3] as u32;
            if alpha > 0 {
                for channel in &mut p[..3] {
                    *channel = ((*channel as u32 * 255 + alpha / 2) / alpha).min(255) as u8;
                }
            }
        }
        DynamicImage::ImageRgba8(
            image::RgbaImage::from_raw(width, height, rgba).ok_or("Logo verkleinen mislukt")?,
        )
    } else {
        let mut reader = image::ImageReader::new(Cursor::new(bytes))
            .with_guessed_format()
            .map_err(|_| "Geen leesbare afbeelding")?;
        let mut limits = image::Limits::default();
        limits.max_image_width = Some(32768);
        limits.max_image_height = Some(32768);
        limits.max_alloc = Some(256 * 1024 * 1024);
        reader.limits(limits);
        reader
            .decode()
            .map_err(|_| "Geen leesbare afbeelding. Kies PNG, JPG, GIF, WebP, BMP of SVG.")?
    };
    let mut image = fit(image, 1024);
    let (w, h) = image.dimensions();
    let rgba = image.to_rgba8();
    let (mut left, mut top, mut right, mut bottom) = (w, h, 0, 0);
    let mut visible = false;
    for (x, y, p) in rgba.enumerate_pixels() {
        if p.0[3] > 8 {
            left = left.min(x);
            top = top.min(y);
            right = right.max(x);
            bottom = bottom.max(y);
            visible = true;
        }
    }
    if visible {
        image = image.crop_imm(left, top, right - left + 1, bottom - top + 1);
    }
    let (w, h) = image.dimensions();
    if w > 256 || h > 256 {
        image = fit(image, 256);
    }
    let mut output = Cursor::new(Vec::new());
    image
        .write_to(&mut output, ImageFormat::Png)
        .map_err(|_| "Logo verkleinen mislukt")?;
    Ok(output.into_inner())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn trims_transparent_margins_and_preserves_aspect_ratio() {
        let mut rgba = image::RgbaImage::new(800, 400);
        for y in 100..300 {
            for x in 100..700 {
                rgba.put_pixel(x, y, image::Rgba([255, 0, 0, 255]));
            }
        }
        let mut bytes = Cursor::new(Vec::new());
        DynamicImage::ImageRgba8(rgba)
            .write_to(&mut bytes, ImageFormat::Png)
            .unwrap();
        let output = prepare(bytes.get_ref()).unwrap();
        let image = image::load_from_memory(&output).unwrap();
        assert_eq!(image.dimensions(), (256, 85));
        assert_eq!(image.to_rgba8().get_pixel(128, 42).0, [255, 0, 0, 255]);
    }
    #[test]
    fn reads_svg_and_rejects_unreadable_files() {
        let output=prepare(br##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 80 40"><rect width="80" height="40" fill="#ff0000"/></svg>"##).unwrap();
        assert_eq!(
            image::load_from_memory(&output).unwrap().dimensions(),
            (256, 128)
        );
        assert!(prepare(b"not an image").is_err());
    }
}
