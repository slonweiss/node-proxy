# RealEyes AI Image Node Proxy Service

A serverless AWS Lambda service that analyzes images for authenticity using machine learning, extracts metadata, stores results in DynamoDB, and returns responses to the client.

## Features

- Image analysis using SageMaker ML model
- Perceptual hash (pHash) calculation
- SHA-256 hash verification
- Metadata extraction (EXIF, C2PA, Sharp)
- Duplicate detection
- S3 storage with verification
- CORS support for major social platforms
- Image feedback system

## Architecture

- AWS Lambda for serverless execution
- Amazon S3 for image storage
- Amazon DynamoDB for metadata and results storage
- Amazon SageMaker for ML inference
- AWS SAM for infrastructure as code

## Environment Variables

- `S3_BUCKET`: S3 bucket name for image storage
- `DYNAMODB_TABLE`: DynamoDB table name for image metadata
- `AWS_REGION`: AWS region (defaults to us-east-2)
- `SAGEMAKER_ENDPOINT_NAME`: SageMaker endpoint for ML inference

## API Endpoints

### POST /analyze-image

Analyzes an image and stores results.

**Request:**

- Content-Type: multipart/form-data
- Body:
  - Image file
  - URL (optional)

**Response:**

```json
{
  "message": "Image uploaded successfully",
  "imageHash": "sha256-hash",
  "pHash": "perceptual-hash",
  "s3ObjectUrl": "https://...",
  "dataMatch": true,
  "originalFileName": "image.jpg",
  "originWebsites": ["https://..."],
  "requestCount": 1,
  "imageOriginUrl": "https://...",
  "fileExtension": ".jpg",
  "extensionSource": "file header",
  "sageMakerAnalysis": {
    "logit": 0.123,
    "probability": 0.987,
    "isFake": false
  }
}
```

### POST /submit-feedback

Submits user feedback for an analyzed image.

**Request:**

```json
{
  "imageHash": "sha256-hash",
  "feedbackType": "up|down",
  "comment": "User feedback comment"
}
```

## Security

- CORS restrictions for allowed origins
- File type verification
- Content validation
- Hash verification
- AWS IAM role-based access

## Supported File Types

- JPEG (.jpg, .jpeg)
- PNG (.png)
- WebP (.webp)
- BMP (.bmp)
- TIFF (.tiff)

## Development

The project uses Node.js 20.x with the following key dependencies:

- @aws-sdk/client-s3
- @aws-sdk/client-dynamodb
- @aws-sdk/client-sagemaker-runtime
- sharp
- imghash
- c2pa
- lambda-multipart-parser

## License

ISC

```

```
