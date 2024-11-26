import {
  DynamoDBClient,
  PutItemCommand,
  GetItemCommand,
  UpdateItemCommand,
} from "@aws-sdk/client-dynamodb";

const dynamoDBClient = new DynamoDBClient({ region: process.env.AWS_REGION });

export const handler = async (event) => {
  console.log("Raw event:", event);
  console.log("Event body:", event.body);
  console.log("Is base64 encoded:", event.isBase64Encoded);

  const body = event.isBase64Encoded
    ? Buffer.from(event.body, "base64").toString()
    : event.body;

  console.log("Decoded body:", body);

  const { imageHash, feedbackType, comment, userId } = JSON.parse(body);

  if (!userId) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: "UserId is required" }),
    };
  }

  if (feedbackType !== "up" && feedbackType !== "down") {
    return {
      statusCode: 400,
      body: JSON.stringify({
        error: 'Invalid feedbackType. Must be "up" or "down".',
      }),
    };
  }

  // Check if user has already submitted feedback for this image
  const existingFeedback = await dynamoDBClient.send(
    new GetItemCommand({
      TableName: process.env.COMMENT_TABLE,
      Key: {
        ImageHash: { S: imageHash },
        UserId: { S: userId },
      },
    })
  );

  if (existingFeedback.Item) {
    return {
      statusCode: 409, // Conflict
      body: JSON.stringify({
        error: "User has already submitted feedback for this image",
      }),
    };
  }

  const putParams = {
    TableName: process.env.COMMENT_TABLE,
    Item: {
      ImageHash: { S: imageHash },
      UserId: { S: userId },
      Type: { S: feedbackType },
      Comment: { S: comment || "" },
      Timestamp: { S: new Date().toISOString() },
    },
    // Add a condition to ensure the item doesn't exist (extra safety check)
    ConditionExpression:
      "attribute_not_exists(ImageHash) AND attribute_not_exists(UserId)",
  };

  try {
    await dynamoDBClient.send(new PutItemCommand(putParams));

    // Also update the count in the cache table
    const updateCountParams = {
      TableName: process.env.DYNAMODB_TABLE,
      Key: {
        ImageHash: { S: imageHash },
      },
      UpdateExpression: "ADD #feedbackType :inc",
      ExpressionAttributeNames: {
        "#feedbackType": feedbackType === "up" ? "ThumbsUp" : "ThumbsDown",
      },
      ExpressionAttributeValues: {
        ":inc": { N: "1" },
      },
    };

    await dynamoDBClient.send(new UpdateItemCommand(updateCountParams));

    return {
      statusCode: 200,
      body: JSON.stringify({
        message: "Feedback submitted successfully",
        imageHash: imageHash,
        userId: userId,
        feedbackType: feedbackType,
      }),
    };
  } catch (error) {
    if (error.name === "ConditionalCheckFailedException") {
      return {
        statusCode: 409,
        body: JSON.stringify({
          error: "User has already submitted feedback for this image",
        }),
      };
    }

    console.error("Error submitting feedback:", error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Failed to submit feedback" }),
    };
  }
};
