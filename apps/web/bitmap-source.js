const IMAGE_DB_NAME = "kaleidoscope.workspace";
const IMAGE_DB_VERSION = 1;
const IMAGE_STORE_NAME = "source-images";
const SOURCE_IMAGE_KEY = "last-uploaded";
const LEGACY_IMAGE_STORAGE_KEY = "kaleidoscope.sourceImage.v10";

/**
 * A browser-backed bitmap source. It deliberately has no WebGL dependency:
 * Renderer reads its current frame and performs the GPU upload.
 */
export class BitmapSource {
  constructor({
    indexedDB = globalThis.indexedDB,
    storage = globalThis.localStorage,
    ImageCtor = globalThis.Image,
    createObjectURL = URL.createObjectURL.bind(URL),
    revokeObjectURL = URL.revokeObjectURL.bind(URL),
    fetch = globalThis.fetch.bind(globalThis)
  } = {}) {
    this.indexedDB = indexedDB;
    this.storage = storage;
    this.ImageCtor = ImageCtor;
    this.createObjectURL = createObjectURL;
    this.revokeObjectURL = revokeObjectURL;
    this.fetch = fetch;
    this.image = null;
    this.width = 2;
    this.height = 2;
    this.revision = 0;
    this.dbPromise = null;
  }

  getResolution() {
    return [this.width, this.height];
  }

  getFrame() {
    if (!this.image) return null;
    return { pixels: this.image, width: this.width, height: this.height, revision: this.revision };
  }

  async load(source) {
    const isDataUrl = typeof source === "string" && source.startsWith("data:image/");
    const isImageFile = source && typeof source.type === "string" && source.type.startsWith("image/");
    if (!isDataUrl && !isImageFile) {
      throw new Error("The selected source is not a supported image.");
    }

    const image = await this.decode(source, isDataUrl);
    this.image = image;
    this.width = image.naturalWidth || image.width;
    this.height = image.naturalHeight || image.height;
    this.revision += 1;
  }

  async save(source) {
    if (!source || !source.type || !source.type.startsWith("image/")) return;
    const db = await this.openDatabase();
    const transaction = db.transaction(IMAGE_STORE_NAME, "readwrite");
    transaction.objectStore(IMAGE_STORE_NAME).put(source, SOURCE_IMAGE_KEY);
    await transactionComplete(transaction);
  }

  async restore() {
    const saved = await this.readSavedImage();
    if (saved) {
      await this.load(saved);
      return { restored: true, migrated: false };
    }

    const legacy = this.readLegacyImage();
    if (!legacy) return { restored: false, migrated: false };
    await this.load(legacy);

    try {
      const response = await this.fetch(legacy);
      const source = await response.blob();
      if (!source.type.startsWith("image/")) throw new Error("The legacy source image has an invalid type.");
      await this.save(source);
      this.storage.removeItem(LEGACY_IMAGE_STORAGE_KEY);
      return { restored: true, migrated: true };
    } catch (error) {
      return { restored: true, migrated: false, migrationError: error };
    }
  }

  decode(source, isDataUrl) {
    return new Promise((resolve, reject) => {
      const image = new this.ImageCtor();
      const objectUrl = isDataUrl ? null : this.createObjectURL(source);
      image.onload = () => {
        if (objectUrl) this.revokeObjectURL(objectUrl);
        resolve(image);
      };
      image.onerror = () => {
        if (objectUrl) this.revokeObjectURL(objectUrl);
        reject(new Error("The browser could not decode this image."));
      };
      image.src = isDataUrl ? source : objectUrl;
    });
  }

  async openDatabase() {
    if (this.dbPromise) return this.dbPromise;
    if (!this.indexedDB) throw new Error("IndexedDB is not supported by this browser.");
    this.dbPromise = new Promise((resolve, reject) => {
      const request = this.indexedDB.open(IMAGE_DB_NAME, IMAGE_DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(IMAGE_STORE_NAME)) db.createObjectStore(IMAGE_STORE_NAME);
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error("IndexedDB is blocked by another tab."));
    });
    return this.dbPromise;
  }

  async readSavedImage() {
    const db = await this.openDatabase();
    const transaction = db.transaction(IMAGE_STORE_NAME, "readonly");
    const request = transaction.objectStore(IMAGE_STORE_NAME).get(SOURCE_IMAGE_KEY);
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error);
      transaction.onabort = () => reject(transaction.error);
    });
  }

  readLegacyImage() {
    try {
      return this.storage?.getItem(LEGACY_IMAGE_STORAGE_KEY) || null;
    } catch {
      return null;
    }
  }
}

function transactionComplete(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}
