
const fs = require("fs");
const path = require("path");
const readline = require("readline");

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

const ask = (question) =>
  new Promise((resolve) => rl.question(question, resolve));

async function main() {
  try {
    console.log("\n===== QuizDrop AI Image Test =====\n");

    // Enter the image filename
    const filename = await ask(
      "Enter image filename (e.g. photosynthesis.png): "
    );

    const imagePath = path.resolve(filename.trim());

    if (!fs.existsSync(imagePath)) {
      throw new Error("Image file not found: " + imagePath);
    }

    // Detect the image type
    const extension = path.extname(imagePath).toLowerCase();

    const mimeTypes = {
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".webp": "image/webp"
    };

    const mimeType = mimeTypes[extension];

    if (!mimeType) {
      throw new Error(
        "Unsupported image type. Use PNG, JPG, JPEG, or WebP."
      );
    }

    // Read and encode the image
    const image = fs.readFileSync(imagePath);
    const imageData =
      `data:${mimeType};base64,` + image.toString("base64");

    const questionCountInput = await ask(
      "How many questions? (1-10, default 5): "
    );

    const questionCount = questionCountInput.trim()
      ? Number(questionCountInput)
      : 5;

    if (
      !Number.isInteger(questionCount) ||
      questionCount < 1 ||
      questionCount > 10
    ) {
      throw new Error("Enter a whole number between 1 and 10.");
    }

    console.log("\nSending image to QuizDrop AI...");
    console.log("Image:", path.basename(imagePath));
    console.log("Size:", (image.length / 1024).toFixed(1), "KB");
    console.log("Please wait...\n");

    // Send the image to the backend
    const response = await fetch(
      "http://localhost:3000/api/generate-quiz",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          imageData,
          mimeType,
          questionCount
        })
      }
    );

    const result = await response.json();

    console.log("HTTP Status:", response.status);

    if (!response.ok) {
      console.log("Quiz generation failed:");
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    if (!Array.isArray(result.questions)) {
      console.log("Unexpected response:");
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    // Display the generated quiz
    console.log("\n================================");
    console.log("QUIZ:", result.title || "Your Quiz");
    console.log("================================\n");

    result.questions.forEach((q, index) => {
      console.log(`${index + 1}. ${q.question}`);

      (q.options || []).forEach((option, optionIndex) => {
        const letter = String.fromCharCode(65 + optionIndex);
        console.log(`   ${letter}. ${option}`);
      });

      if (Number.isInteger(q.correctIndex)) {
        console.log(
          "   Correct answer:",
          String.fromCharCode(65 + q.correctIndex)
        );
      }

      if (q.explanation) {
        console.log("   Explanation:", q.explanation);
      }

      console.log();
    });

    console.log("===== Test Complete =====");
  } catch (error) {
    console.error("\nTest failed:", error.message);

    if (error.cause) {
      console.error("Details:", error.cause.message);
    }
  } finally {
    rl.close();
  }
}

main();
