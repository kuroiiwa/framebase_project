export function livePhotoVideoNames(imageName: string): string[];
export function findLivePhotoVideo<T extends { name: string }>(imageName: string, files: T[]): T | null;
