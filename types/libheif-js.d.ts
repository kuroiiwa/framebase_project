declare module "libheif-js/wasm-bundle.js" {
  type HeifImage = {
    get_width(): number;
    get_height(): number;
    is_primary?(): boolean;
    display(imageData: ImageData, callback: (result: ImageData | null) => void): void;
    free?(): void;
  };

  type HeifDecoder = {
    decode(data: ArrayBuffer | Uint8Array): HeifImage[];
  };

  const libheif: {
    HeifDecoder: new () => HeifDecoder;
  };

  export default libheif;
}
