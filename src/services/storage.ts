import {
    S3Client,
    PutObjectCommand,
    GetObjectCommand,
    DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const endpoint = process.env.STORAGE_ENDPOINT;
const bucket = process.env.STORAGE_BUCKET!;
const region = process.env.STORAGE_REGION || 'us-east-1';
const accessKeyId = process.env.STORAGE_ACCESS_KEY!;
const secretAccessKey = process.env.STORAGE_SECRET_KEY!;

const s3 = new S3Client({
    region,
    credentials: { accessKeyId, secretAccessKey },
    // When STORAGE_ENDPOINT is set (MinIO or custom S3-compatible), use it as the endpoint
    ...(endpoint
        ? {
            endpoint,
            forcePathStyle: true, // Required for MinIO
        }
        : {}),
});

/**
 * Generate a presigned URL for uploading a file directly from the browser.
 * The upload URL expires in `expiresIn` seconds (default 5 minutes).
 */
export async function generateUploadUrl(
    fileKey: string,
    mimeType: string,
    expiresIn = 300
): Promise<string> {
    const command = new PutObjectCommand({
        Bucket: bucket,
        Key: fileKey,
        ContentType: mimeType,
    });
    return getSignedUrl(s3, command, { expiresIn });
}

/**
 * Generate a presigned URL for downloading / viewing a file.
 * The URL expires in `expiresIn` seconds (default 1 hour).
 */
export async function generateDownloadUrl(
    fileKey: string,
    expiresIn = 3600
): Promise<string> {
    const command = new GetObjectCommand({
        Bucket: bucket,
        Key: fileKey,
    });
    return getSignedUrl(s3, command, { expiresIn });
}

/**
 * Permanently delete an object from storage.
 */
export async function deleteObject(fileKey: string): Promise<void> {
    const command = new DeleteObjectCommand({
        Bucket: bucket,
        Key: fileKey,
    });
    await s3.send(command);
}
