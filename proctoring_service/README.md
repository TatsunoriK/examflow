# ExamFlow camera review service

This separate Python service analyzes short webcam clips uploaded by ExamFlow. It returns review cues only; it must not be used to automatically accuse or penalize a student.

## Prepare trusted model assets

1. Use `exam_proctoring_v2.py` to extract `data.csv` and create `labels_human.csv`. Review clips independently; do not treat rule-generated or auto-corrected labels as ground truth.
2. Install the pinned, lightweight training dependencies and train only from the human labels:

   ```sh
   python -m pip install -r proctoring_service/requirements-train.txt
   python proctoring_service/train_model.py \
     --data /path/to/outputs/data.csv \
     --labels /path/to/outputs/labels_human.csv \
     --model-out /private/examflow-models/exam_cheating_rf.joblib
   ```

   The trainer requires all three classes in train and a separate held-out test split by video. Check the printed metrics and confusion matrix before deployment.
3. Copy the exact `face_landmarker.task`, `hand_landmarker.task`, and `yolov8s.pt` assets used to generate the training features into the private model directory.
4. Keep these assets outside the web app and do not commit them. The service validates the feature-column order in the bundle before accepting analysis requests.

The model file does not exist until the human-labeling/training step has completed. Without all four assets, `/health` reports `model_ready: false` and `/analyze` returns HTTP 503; ExamFlow keeps the recording and marks the analysis unavailable.

## Run in a container

Build the image from the repository root:

```sh
docker build -t examflow-proctoring ./proctoring_service
```

Mount the private model directory read-only at `/models`, set a long random `PROCTORING_API_TOKEN`, and expose port 8080 only over HTTPS. The service accepts only authenticated WebM/MP4 requests and limits each clip to 20 MB.

Set `PROCTORING_API_TOKEN` to a long random secret using your hosting platform's secret manager, and mount the private model directory read-only at `/models`.

Check `GET /health` and verify `model_ready` is `true`. Do not expose the service without TLS or its bearer token.

## Connect the Cloudflare Worker

Set `PROCTORING_API_URL` to the public HTTPS origin of the service (for example `https://proctoring.example.org`) in the Worker environment. Add `PROCTORING_API_TOKEN` as a Worker secret with the same value configured on the inference service. Never put the token in browser code or a checked-in file.

The Worker sends each webcam segment to `/analyze`. It stores bounded review cues and model status in D1; raw clips remain in the existing R2 bucket under the `camera/` prefix. If the service is absent or unavailable, the exam and recording continue, and the teacher sees that the AI result is unavailable.

## Retention and privacy

Before enabling webcam exams in production, configure an R2 object-lifecycle rule for prefix `camera/` to expire objects after **30 days**. This rule must be configured on the bucket in Cloudflare; application code cannot create or verify it. D1 review cues are not automatically deleted by that rule. Set a separate D1 retention/deletion policy with the institution. Screen recordings use a different key prefix and keep their pre-existing retention behavior.

The student must explicitly consent and grant browser camera and screen permissions. The inference service temporarily writes uploads to a per-request temporary directory and deletes that directory after analysis. Avoid request-body logging, retain the API token as a secret, and disclose the inference host, data use, retention, and review process to students before an exam.

## Limits

This is a frame-level screening model, not proof of misconduct. Lighting, camera placement, accessibility needs, object-detection errors, and training-data bias can all cause false alerts or missed cues. A teacher must review the matching webcam segment and context. If there are no human-reviewed labels and a validated held-out test set, do not interpret confidence values as real-world accuracy.
