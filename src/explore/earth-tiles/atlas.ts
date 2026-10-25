import { DataTexture, LinearFilter, NearestFilter, NoColorSpace, RepeatWrapping, RGBAFormat, SRGBColorSpace, UnsignedByteType, type WebGPURenderer } from 'three/webgpu';

/**
 * A texture tiles are written into, region by region, straight from decoded images.
 *
 * three.js uploads a texture whole; a 2048 x 2048 atlas written whole for every arriving 256 px tile
 * would cost each frame tens of milliseconds. As ../assets/upload does for the planet maps, three
 * creates the GPU texture at its full size from a one-texel stub (so creating it writes almost
 * nothing), and each tile then goes straight to its region through the backend three drives:
 * GPUQueue.copyExternalImageToTexture on WebGPU, texSubImage2D on WebGL2. Both take an ImageBitmap,
 * which the browser has already decoded off the main thread.
 *
 * Colour atlases are sRGB and filtered (sampling returns linear colour, as the planet maps do); data
 * atlases (terrain heights, encoded in the bytes) are linear and read nearest, so no byte is changed
 * on the way and no two heights are blended before they are decoded. Rows are stored top first (no
 * flip): the shader reads row 0 as the tile's northern edge. Wrapping repeats, so a window of tiles
 * can be addressed toroidally (tile column x lives in atlas column x mod k).
 */

interface BackendLike {
  isWebGPUBackend?: boolean;
  isWebGLBackend?: boolean;
  device?: {
    queue: {
      copyExternalImageToTexture(source: { source: ImageBitmap; flipY?: boolean }, destination: Record<string, unknown>, size: Record<string, number>): void;
    };
  };
  gl?: WebGL2RenderingContext;
  state?: { bindTexture(target: number, texture: unknown): void; pixelStorei(name: number, value: number | boolean): void };
  get(object: object): Record<string, unknown>;
}

export interface TileAtlas {
  readonly texture: DataTexture;
  /** Pixels across (width) and down (height). */
  readonly width: number;
  readonly height: number;
  /** Writes an image with its top-left at (x, y); false when the backend cannot (the tile is then dropped). */
  write(image: ImageBitmap, x: number, y: number): boolean;
  dispose(): void;
}

export function createAtlas(renderer: WebGPURenderer, width: number, height: number, colour: boolean, name: string): TileAtlas {
  const stub = new Uint8Array([0, 0, 0, 0]);
  const texture = new DataTexture(stub, width, height, RGBAFormat, UnsignedByteType);
  texture.name = name;
  texture.colorSpace = colour ? SRGBColorSpace : NoColorSpace;
  texture.wrapS = RepeatWrapping;
  texture.wrapT = RepeatWrapping;
  texture.magFilter = colour ? LinearFilter : NearestFilter;
  texture.minFilter = colour ? LinearFilter : NearestFilter;
  texture.generateMipmaps = false;
  texture.flipY = false;
  // The stub: three sizes the texture from image (width x height) and writes only this one-texel level.
  texture.mipmaps = [{ data: stub, width: 1, height: 1 }];
  // A new texture is at version 0, which three would only stand in for with its 1 x 1 default.
  texture.needsUpdate = true;
  renderer.initTexture(texture);

  const backend = renderer.backend as unknown as BackendLike;
  const data = (): Record<string, unknown> => backend.get(texture);

  const write = (image: ImageBitmap, x: number, y: number): boolean => {
    try {
      if (backend.isWebGPUBackend && backend.device) {
        const gpuTexture = data()['texture'];
        if (!gpuTexture) return false;
        backend.device.queue.copyExternalImageToTexture(
          { source: image, flipY: false },
          { texture: gpuTexture, origin: { x, y, z: 0 }, colorSpace: 'srgb', premultipliedAlpha: false },
          { width: image.width, height: image.height, depthOrArrayLayers: 1 },
        );
        return true;
      }
      if (backend.isWebGLBackend && backend.gl && backend.state) {
        const gl = backend.gl;
        const handle = data()['textureGPU'];
        if (!handle) return false;
        backend.state.bindTexture(gl.TEXTURE_2D, handle);
        backend.state.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
        backend.state.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
        backend.state.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
        // Data tiles keep their exact bytes (no colour-space conversion by the browser).
        gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, colour ? gl.BROWSER_DEFAULT_WEBGL : gl.NONE);
        gl.texSubImage2D(gl.TEXTURE_2D, 0, x, y, gl.RGBA, gl.UNSIGNED_BYTE, image);
        gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.BROWSER_DEFAULT_WEBGL);
        return true;
      }
    } catch (err) {
      console.warn('explore: a tile could not be written', err);
    }
    return false;
  };

  return {
    texture,
    width,
    height,
    write,
    dispose() {
      texture.dispose();
    },
  };
}
