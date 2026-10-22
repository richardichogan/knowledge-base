export function storedImageId(source: string): string | undefined {
  return new URL(source, 'https://athena.invalid').pathname.match(/^\/kb-images\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i)?.[1];
}

export async function imageAsPng(source: string, loadStoredImage?: (id: string) => Promise<Blob>): Promise<Blob> {
  const storedId = storedImageId(source);
  let blob: Blob;
  if (storedId && loadStoredImage) blob = await loadStoredImage(storedId);
  else {
    const response = await fetch(source);
    if (!response.ok) throw new Error(`Could not read the image (${response.status}).`);
    blob = await response.blob();
  }
  if (!blob.type.startsWith('image/')) throw new Error('The image URL did not return an image.');
  if (blob.size > 25_000_000) throw new Error('This image is too large to copy (25 MB limit).');
  if (blob.type === 'image/svg+xml') {
    const url = URL.createObjectURL(blob);
    try {
      const image = new Image();
      image.src = url;
      await image.decode();
      return await pixelsAsPng(image, image.naturalWidth, image.naturalHeight);
    } finally { URL.revokeObjectURL(url); }
  }
  const bitmap = await createImageBitmap(blob);
  try {
    return await pixelsAsPng(bitmap, bitmap.width, bitmap.height);
  } finally { bitmap.close(); }
}

async function pixelsAsPng(image: CanvasImageSource, width: number, height: number): Promise<Blob> {
    if (!width || !height || width * height > 40_000_000) throw new Error('This image is too large to copy safely.');
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Image copying is unavailable in this browser.');
    context.drawImage(image, 0, 0);
    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(value => value ? resolve(value) : reject(new Error('Could not prepare the image for copying.')), 'image/png');
    });
}

export async function copyImage(source: string, loadStoredImage?: (id: string) => Promise<Blob>): Promise<void> {
  if (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined') throw new Error('Image copying requires an updated browser or Athena Desktop.');
  // Start clipboard access in the click gesture, before fetching/converting the image.
  await navigator.clipboard.write([new ClipboardItem({ 'image/png': imageAsPng(source, loadStoredImage) })]);
}
