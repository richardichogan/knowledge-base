export async function imageAsPng(source: string): Promise<Blob> {
  const response = await fetch(source);
  if (!response.ok) throw new Error(`Could not read the image (${response.status}).`);
  const blob = await response.blob();
  if (!blob.type.startsWith('image/')) throw new Error('The image URL did not return an image.');
  if (blob.size > 25_000_000) throw new Error('This image is too large to copy (25 MB limit).');
  const bitmap = await createImageBitmap(blob);
  try {
    if (!bitmap.width || !bitmap.height || bitmap.width * bitmap.height > 40_000_000) throw new Error('This image is too large to copy safely.');
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Image copying is unavailable in this browser.');
    context.drawImage(bitmap, 0, 0);
    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(value => value ? resolve(value) : reject(new Error('Could not prepare the image for copying.')), 'image/png');
    });
  } finally { bitmap.close(); }
}

export async function copyImage(source: string): Promise<void> {
  if (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined') throw new Error('Image copying requires an updated browser or Athena Desktop.');
  // Start clipboard access in the click gesture, before fetching/converting the image.
  await navigator.clipboard.write([new ClipboardItem({ 'image/png': imageAsPng(source) })]);
}
