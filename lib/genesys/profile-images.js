function resolutionSize(value) {
  const numbers = String(value || "").match(/\d+/g)?.map(Number).filter(Number.isFinite) || [];
  return numbers.length ? Math.max(...numbers) : 0;
}

const MAX_PROFILE_IMAGE_BYTES = 5 * 1024 * 1024;

function detectedImageContentType(bytes) {
  if (
    bytes.length >= 3
    && bytes[0] === 0xff
    && bytes[1] === 0xd8
    && bytes[2] === 0xff
  ) return "image/jpeg";
  if (
    bytes.length >= 8
    && bytes[0] === 0x89
    && bytes[1] === 0x50
    && bytes[2] === 0x4e
    && bytes[3] === 0x47
    && bytes[4] === 0x0d
    && bytes[5] === 0x0a
    && bytes[6] === 0x1a
    && bytes[7] === 0x0a
  ) return "image/png";
  if (
    bytes.length >= 6
    && String.fromCharCode(...bytes.slice(0, 6)).match(/^GIF8[79]a$/)
  ) return "image/gif";
  if (
    bytes.length >= 12
    && String.fromCharCode(...bytes.slice(0, 4)) === "RIFF"
    && String.fromCharCode(...bytes.slice(8, 12)) === "WEBP"
  ) return "image/webp";
  return null;
}

function expectedGenesysImageHost(environment) {
  const host = String(environment || "mypurecloud.com")
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/$/, "");
  return `api-downloads.${host}`;
}

export function isGenesysProfileImageUri(imageUri, environment = process.env.GC_ENVIRONMENT) {
  try {
    const url = new URL(String(imageUri || ""));
    return url.protocol === "https:"
      && url.hostname.toLowerCase() === expectedGenesysImageHost(environment);
  } catch {
    return false;
  }
}

export async function downloadGenesysProfileImage({
  imageUri,
  accessToken,
  environment = process.env.GC_ENVIRONMENT,
  fetchImpl = fetch,
}) {
  if (!isGenesysProfileImageUri(imageUri, environment)) {
    throw new Error("Genesys profile picture URI is not allowed");
  }

  let response = await fetchImpl(imageUri, {
    headers: { Authorization: `Bearer ${accessToken}` },
    cache: "no-store",
  });
  if (!response.ok && (response.status === 401 || response.status === 403)) {
    // Some Genesys image links are signed CDN URLs which reject an additional
    // OAuth header even though the URL itself grants access.
    response = await fetchImpl(imageUri, { cache: "no-store" });
  }
  if (!response.ok) throw new Error(`Genesys profile picture returned ${response.status}`);

  const declaredLength = Number(response.headers.get("content-length") || 0);
  if (declaredLength > MAX_PROFILE_IMAGE_BYTES) {
    throw new Error("Genesys profile picture is too large");
  }
  const body = new Uint8Array(await response.arrayBuffer());
  if (!body.length || body.length > MAX_PROFILE_IMAGE_BYTES) {
    throw new Error("Genesys profile picture is empty or too large");
  }
  // api-downloads.* currently returns profile JPEGs as binary/octet-stream.
  // Sniff a small set of safe raster formats instead of trusting that header.
  const contentType = detectedImageContentType(body);
  if (!contentType) throw new Error("Genesys returned an invalid profile picture");
  return { body, contentType };
}

export function selectGenesysProfileImage(images, targetSize = 256) {
  const source = Array.isArray(images)
    ? images
    : Array.isArray(images?.entities)
      ? images.entities
      : [];
  const candidates = source
    .map((image) => ({
      uri: String(image?.imageUri || image?.imageUrl || image?.uri || image?.url || "").trim(),
      size: resolutionSize(image?.resolution),
    }))
    .filter((image) => {
      try {
        return new URL(image.uri).protocol === "https:";
      } catch {
        return false;
      }
    });

  candidates.sort((left, right) => {
    const leftLargeEnough = left.size >= targetSize;
    const rightLargeEnough = right.size >= targetSize;
    if (leftLargeEnough !== rightLargeEnough) return leftLargeEnough ? -1 : 1;
    if (leftLargeEnough) return left.size - right.size;
    return right.size - left.size;
  });
  return candidates[0]?.uri || null;
}
