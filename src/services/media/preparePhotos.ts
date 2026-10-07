/**
 * Pick and prepare application photos.
 *
 * Every photo is resized (long edge ≤ 1080) and re-encoded as JPEG before
 * upload: smaller transfers, and re-encoding drops EXIF metadata such as GPS
 * location — a privacy requirement, not just an optimisation.
 */
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import * as ImagePicker from 'expo-image-picker';
import { Platform } from 'react-native';

export type PreparedPhoto = { uri: string; dataUri: string; width: number; height: number };

const MAX_EDGE = 1080;

export async function pickPhotos(limit: number): Promise<{ assets: ImagePicker.ImagePickerAsset[] } | null> {
  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ['images'],
    allowsMultipleSelection: limit > 1,
    selectionLimit: Math.max(1, limit),
    quality: 1,
    exif: false,
  });
  if (result.canceled || !result.assets?.length) return null;
  return { assets: result.assets.slice(0, limit) };
}

/**
 * A fresh photo to confirm identity (VERIFY_IDENTITY). Front camera on
 * devices; the web build falls back to choosing a file. Returns null when the
 * applicant cancels or declines camera access.
 */
export async function takeVerificationPhoto(): Promise<{ assets: ImagePicker.ImagePickerAsset[] } | null> {
  if (Platform.OS === 'web') return pickPhotos(1);
  const permission = await ImagePicker.requestCameraPermissionsAsync();
  if (!permission.granted) return null;
  const result = await ImagePicker.launchCameraAsync({
    mediaTypes: ['images'],
    cameraType: ImagePicker.CameraType.front,
    quality: 1,
    exif: false,
  });
  if (result.canceled || !result.assets?.length) return null;
  return { assets: result.assets.slice(0, 1) };
}

export async function preparePhoto(asset: { uri: string; width: number; height: number }): Promise<PreparedPhoto> {
  const context = ImageManipulator.manipulate(asset.uri);
  const longEdge = Math.max(asset.width, asset.height);
  if (longEdge > MAX_EDGE) {
    context.resize(asset.width >= asset.height ? { width: MAX_EDGE } : { height: MAX_EDGE });
  }
  const rendered = await context.renderAsync();
  const saved = await rendered.saveAsync({ format: SaveFormat.JPEG, compress: 0.72, base64: true });
  if (!saved.base64) throw new Error('Photo could not be encoded');
  return {
    uri: saved.uri,
    dataUri: `data:image/jpeg;base64,${saved.base64}`,
    width: saved.width,
    height: saved.height,
  };
}
