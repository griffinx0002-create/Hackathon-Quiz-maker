
require("dotenv").config();

const express = require("express");
const cors = require("cors");

const app = express();
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.GEMINI_API_KEY;
const MODEL = process.env.GEMINI_MODEL || "gemini-3.8-flash";

app.use(cors());
app.use(express.json({ limit: "15mb" }));

// Health check
app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    aiConfigured: Boolean(API_KEY)
  });
});

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Read responses safely, even when the response body is empty.
async function readResponse(response) {
  const rawText = await response.text();

  if (!rawText.trim()) {
    const error = new Error(
      `Gemini returned an empty response (HTTP ${response.status}).`
    );
    error.status = response.status || 502;
    throw error;
  }

  try {
    return JSON.parse(rawText);
  } catch {
    console.error("Invalid JSON from Gemini:", rawText.slice(0, 500));

    const error = new Error(
      `Gemini returned an invalid response (HTTP ${response.status}).`
    );
    error.status = response.status || 502;
    throw error;
  }
}

// Request Gemini, retrying temporary errors.
async function callGemini(payload) {
  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent` +
    `?key=${API_KEY}`;

  const maxRetries = 2;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(90000)
      });

      const rawText = await response.text();

      let data;

      if (!rawText.trim()) {
        const error = new Error(
          `Gemini returned an empty response (HTTP ${response.status}).`
        );
        error.status = response.status || 502;
        throw error;
      }

      try {
        data = JSON.parse(rawText);
      } catch {
        console.error(
          "Gemini response was not valid JSON:",
          rawText.slice(0, 500)
        );

        const error = new Error(
          `Gemini returned invalid JSON (HTTP ${response.status}).`
        );
        error.status = response.status || 502;
        throw error;
      }

      if (response.ok) {
        return data;
      }

      const error = new Error(
        data?.error?.message || `Gemini HTTP error ${response.status}`
      );

      error.status = response.status;

      const retryable = [429, 500, 502, 503, 504].includes(
        response.status
      );

      if (!retryable || attempt === maxRetries) {
        throw error;
      }

      const delay = 2000 * (attempt + 1);

      console.log(
        `Gemini HTTP ${response.status}. Retry ${attempt + 1}/${maxRetries} in ${delay / 1000}s.`
      );

      await wait(delay);
    } catch (error) {
      // Do not retry authentication, quota, or other API errors blindly.
      if (
        error.status &&
        ![429, 500, 502, 503, 504].includes(error.status)
      ) {
        throw error;
      }

      if (error.status && attempt === maxRetries) {
        throw error;
      }

      // Retry temporary network failures and timeouts.
      if (!error.status && attempt < maxRetries) {
        const delay = 2000 * (attempt + 1);

        console.log(
          `Connection issue: ${error.message}. Retrying in ${delay / 1000}s.`
        );

        await wait(delay);
        continue;
      }

      if (attempt === maxRetries) {
        throw error;
      }

      // Retry temporary HTTP errors.
      if (error.status) {
        const delay = 2000 * (attempt + 1);
        await wait(delay);
      }
    }
  }

  throw new Error("Gemini request failed after retries.");
}

// Generate quiz from an image.
app.post("/api/generate-quiz", async (req, res) => {
  try {
    if (!API_KEY) {
      return res.status(500).json({
        error: "GEMINI_API_KEY is missing from your .env file."
      });
    }

    const { imageData, mimeType, questionCount, difficulty } = req.body || {};

    if (!imageData || !mimeType) {
      return res.status(400).json({
        error: "Please upload an image."
      });
    }

    const supportedTypes = [
      "image/png",
      "image/jpeg",
      "image/webp"
    ];

    if (!supportedTypes.includes(mimeType)) {
      return res.status(400).json({
        error: "Supported formats are PNG, JPG, JPEG, and WebP."
      });
    }

    const match = imageData.match(
      /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/
    );

    if (!match || match[1] !== mimeType) {
      return res.status(400).json({
        error: "Invalid image data. Please select the image again."
      });
    }

    const count = Number(questionCount ?? 5);

    if (!Number.isInteger(count) || count < 1 || count > 10) {
      return res.status(400).json({
        error: "Choose between 1 and 10 questions."
      });
    }

    const validDifficulties = ["easy", "medium", "hard"];
    const level = validDifficulties.includes(
      String(difficulty || "medium").toLowerCase()
    )
      ? String(difficulty || "medium").toLowerCase()
      : "medium";

    const prompt = `
You are QuizDrop AI, an educational quiz generator.

Read the uploaded image and create exactly ${count} multiple-choice
questions based on its readable educational content.

Difficulty: ${level}.

Rules:
- Base questions on the uploaded material.
- Do not invent details that are not supported by the image.
- If some text is unreadable, use only what you can understand.
- Every question must have exactly four answer options.
- Only one option must be correct.
- correctIndex must be 0, 1, 2, or 3.
- Include a short explanation for each answer.
- Return only valid JSON, with no Markdown or code fences.

Use this exact structure:
{
  "title": "Quiz title",
  "notice": "Brief note about the material",
  "questions": [
    {
      "question": "Question text",
      "options": ["Option A", "Option B", "Option C", "Option D"],
      "correctIndex": 0,
      "explanation": "Short explanation"
    }
  ]
}
`;

    console.log(
      `Generating quiz: ${count} questions, difficulty ${level}.`
    );

    const result = await callGemini({
      contents: [
        {
          parts: [
            { text: prompt },
            {
              inline_data: {
                mime_type: mimeType,
                data: match[2]
              }
            }
          ]
        }
      ],
      generationConfig: {
        responseMimeType: "application/json",
        temperature: 0.3
      }
    });

    const output = result?.candidates?.[0]?.content?.parts
      ?.map(part => part.text || "")
      .join("")
      .trim();

    if (!output) {
      console.error(
        "Gemini returned no quiz text. Finish reason:",
        result?.candidates?.[0]?.finishReason,
        "Feedback:",
        JSON.stringify(result?.promptFeedback || {})
      );

      throw new Error(
        "Gemini could not generate questions from this image. Try a clearer image."
      );
    }

    let quiz;

    try {
      quiz = JSON.parse(output);
    } catch {
      console.error("Quiz JSON parsing failed:", output.slice(0, 500));

      throw new Error(
        "Gemini generated an invalid quiz format. Please try again."
      );
    }

    if (!Array.isArray(quiz.questions)) {
      throw new Error("Gemini did not return a valid list of questions.");
    }

    const questions = quiz.questions.filter(q =>
      typeof q.question === "string" &&
      Array.isArray(q.options) &&
      q.options.length === 4 &&
      q.options.every(option => typeof option === "string") &&
      Number.isInteger(q.correctIndex) &&
      q.correctIndex >= 0 &&
      q.correctIndex <= 3
    );

    if (questions.length === 0) {
      throw new Error(
        "No valid questions were generated. Try a clearer image."
      );
    }

    console.log(`Successfully generated ${questions.length} questions.`);

    return res.json({
      title: quiz.title || "Your Quiz",
      notice: quiz.notice || "",
      questions: questions.slice(0, count).map(q => ({
        question: q.question,
        options: q.options,
        correctIndex: q.correctIndex,
        explanation: q.explanation || ""
      }))
    });
  } catch (error) {
    console.error(
      "Server error:",
      error.status ? `HTTP ${error.status}:` : "",
      error.message
    );

    if (res.headersSent) return;

    let status = 500;
    let message = error.message || "Could not generate the quiz.";

    if (error.status === 400) {
      status = 400;
      message = "Gemini rejected the request. Check the image and request.";
    } else if (error.status === 401 || error.status === 403) {
      status = 502;
      message = "Gemini API authentication failed. Check your API key and model access.";
    } else if (error.status === 429) {
      status = 429;
      message = "Gemini rate limit or quota reached. Please wait before trying again.";
    } else if ([500, 502, 503, 504].includes(error.status)) {
      status = 502;
      message = "Gemini is temporarily unavailable. Please try again shortly.";
    } else if (
      error.name === "TimeoutError" ||
      error.name === "AbortError"
    ) {
      status = 504;
      message = "Gemini took too long to respond. Please try again.";
    }

    return res.status(status).json({ error: message });
  }
});

app.listen(PORT, () => {
  console.log(`SnapQuiz backend running on port ${PORT}`);
  console.log(`Gemini API key configured: ${Boolean(API_KEY)}`);
  console.log(`Gemini model: ${MODEL}`);
});
