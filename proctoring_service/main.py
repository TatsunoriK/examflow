import json
import logging
import math
import os
import secrets
import tempfile
import threading
from pathlib import Path

import cv2
import joblib
import mediapipe as mp
import numpy as np
import pandas as pd
from fastapi import FastAPI, HTTPException, Request
from fastapi.concurrency import run_in_threadpool
from mediapipe.tasks import python as mp_python
from mediapipe.tasks.python import vision
from ultralytics import YOLO

MAX_BYTES = 20 * 1024 * 1024
MAX_FRAMES = 600
MAX_SOURCE_FRAMES = 1800
MAX_CLIP_SECONDS = 30
SAMPLE_FPS = 5
WINDOW_FRAMES = 15
LABELS = {0: "normal", 1: "suspicious", 2: "cheating"}
OBJECTS = ["person", "phone", "tablet", "book", "paper", "earphone", "watch", "laptop", "tv", "remote"]
ALIASES = {
    "person": "person", "cell phone": "phone", "mobile phone": "phone", "tablet": "tablet",
    "book": "book", "paper": "paper", "earphones": "earphone", "headphones": "earphone",
    "smartwatch": "watch", "laptop": "laptop", "tv": "tv", "remote": "remote",
}
COCO_IDS = [0, 62, 63, 65, 67, 73]
L_EYE = [33, 7, 163, 144, 145, 153, 154, 155, 133, 173, 157, 158, 159, 160, 161, 246]
R_EYE = [362, 382, 381, 380, 374, 373, 390, 249, 263, 466, 388, 387, 386, 385, 384, 398]
MOUTH = [61, 146, 91, 181, 84, 17, 314, 405, 321, 375, 291, 409, 270, 269, 267, 0, 37, 39, 40, 185,
         78, 95, 88, 178, 87, 14, 317, 402, 318, 324, 308, 415, 310, 311, 312, 13, 82, 81, 80, 191]
L_EYE6 = [33, 160, 158, 133, 153, 144]
R_EYE6 = [362, 385, 387, 263, 373, 380]
BASE_FEATURES = [
    "n_faces", "n_person", "n_hands", "yaw", "pitch", "roll", "ear", "mar", "gaze_h", "gaze_v",
    "face_area", "hand_near_face", "hand_near_mouth", "yaw_dev", "pitch_dev", "gaze_h_dev",
    "gaze_v_dev", "mar_dev", "phone_face_dist",
]
OBJECT_FEATURES = [f"{name}_conf" for name in OBJECTS]
OBJECT_FEATURES += [f"{name}_n" for name in OBJECTS if name != "person"]
TEMPORAL_FEATURES = [
    "yaw_abs_roll", "pitch_abs_roll", "gaze_abs_roll", "mar_roll_std", "no_face_frac",
    "multi_face_frac", "hand_mouth_frac", "phone_frac", "book_frac", "device_frac", "person_extra_frac",
]
FEATURES = BASE_FEATURES + OBJECT_FEATURES + TEMPORAL_FEATURES

app = FastAPI(title="ExamFlow proctoring inference", version="1.0.0")
logger = logging.getLogger("examflow.proctoring")
model_bundle = None
extractor = None
load_error = None
inference_lock = threading.Lock()


def _load_runtime():
    global model_bundle, extractor, load_error
    try:
        model_path = Path(os.getenv("MODEL_PATH", "/models/exam_cheating_rf.joblib"))
        face_path = Path(os.getenv("FACE_LANDMARKER_PATH", "/models/face_landmarker.task"))
        hand_path = Path(os.getenv("HAND_LANDMARKER_PATH", "/models/hand_landmarker.task"))
        yolo_path = Path(os.getenv("YOLO_WEIGHTS", "/models/yolov8s.pt"))
        missing = [str(path) for path in (model_path, face_path, hand_path, yolo_path) if not path.is_file()]
        if missing:
            load_error = "Required model assets are missing: " + ", ".join(missing)
            logger.warning(load_error)
            return
        bundle = joblib.load(model_path)
        if not isinstance(bundle, dict) or not {"model", "features", "labels"}.issubset(bundle):
            raise ValueError("Model file must contain model, features and labels")
        if list(bundle["features"]) != FEATURES:
            raise ValueError("Model feature columns do not match this service")
        if set(bundle["labels"].values()) != set(LABELS.values()):
            raise ValueError("Model label names do not match the service labels")
        base = mp_python.BaseOptions
        face = vision.FaceLandmarker.create_from_options(vision.FaceLandmarkerOptions(
            base_options=base(model_asset_path=str(face_path)),
            running_mode=vision.RunningMode.IMAGE,
            num_faces=3,
            min_face_detection_confidence=0.5,
            min_face_presence_confidence=0.5,
        ))
        hands = vision.HandLandmarker.create_from_options(vision.HandLandmarkerOptions(
            base_options=base(model_asset_path=str(hand_path)),
            running_mode=vision.RunningMode.IMAGE,
            num_hands=2,
            min_hand_detection_confidence=0.5,
        ))
        detector = YOLO(str(yolo_path))
        model_bundle = bundle
        extractor = (face, hands, detector)
        load_error = None
    except Exception as exc:
        load_error = f"Model runtime failed to load: {type(exc).__name__}: {exc}"
        logger.exception("Could not load the proctoring model runtime")
        model_bundle = None
        extractor = None


_load_runtime()


def _box(points, indices, pad, width, height):
    selected = points if indices is None else points[indices]
    low = selected.min(axis=0)
    high = selected.max(axis=0)
    box_width, box_height = high - low
    return [
        float(max(low[0] - box_width * pad, 0)),
        float(max(low[1] - box_height * pad, 0)),
        float(min(high[0] + box_width * pad, width - 1)),
        float(min(high[1] + box_height * pad, height - 1)),
    ]


def _eye_ratio(points, indices):
    a = np.linalg.norm(points[indices[1]] - points[indices[5]])
    b = np.linalg.norm(points[indices[2]] - points[indices[4]])
    c = np.linalg.norm(points[indices[0]] - points[indices[3]])
    return float((a + b) / (2 * c + 1e-6))


def _face_features(points, width, height):
    face_box = _box(points, None, 0.05, width, height)
    mouth_box = _box(points, MOUTH, 0.15, width, height)
    face_width = points[454, 0] - points[234, 0] + 1e-6
    face_height = points[152, 1] - points[10, 1] + 1e-6
    features = {
        "yaw": float((points[1, 0] - (points[234, 0] + points[454, 0]) / 2) / face_width),
        "pitch": float((points[1, 1] - points[10, 1]) / face_height),
        "roll": float(math.degrees(math.atan2(points[263, 1] - points[33, 1], points[263, 0] - points[33, 0]))),
        "ear": (_eye_ratio(points, L_EYE6) + _eye_ratio(points, R_EYE6)) / 2,
        "mar": float(np.linalg.norm(points[13] - points[14]) / (np.linalg.norm(points[78] - points[308]) + 1e-6)),
        "face_area": float((face_box[2] - face_box[0]) * (face_box[3] - face_box[1]) / (width * height)),
        "gaze_h": 0.0,
        "gaze_v": 0.0,
    }
    if len(points) >= 478:
        left, right = points[468], points[473]
        gaze_left = (left[0] - points[33][0]) / (points[133][0] - points[33][0] + 1e-6)
        gaze_right = (right[0] - points[362][0]) / (points[263][0] - points[362][0] + 1e-6)
        vertical_left = (left[1] - points[159][1]) / (points[145][1] - points[159][1] + 1e-6)
        vertical_right = (right[1] - points[386][1]) / (points[374][1] - points[386][1] + 1e-6)
        features["gaze_h"] = float((gaze_left + gaze_right) / 2)
        features["gaze_v"] = float((vertical_left + vertical_right) / 2)
    return features, face_box, mouth_box


def _inside(points, box, margin):
    width = box[2] - box[0]
    height = box[3] - box[1]
    return bool(((points[:, 0] >= box[0] - margin * width) & (points[:, 0] <= box[2] + margin * width)
                 & (points[:, 1] >= box[1] - margin * height) & (points[:, 1] <= box[3] + margin * height)).any())


def _extract_frame(frame, timestamp, runtime):
    face_model, hand_model, yolo = runtime
    height, width = frame.shape[:2]
    rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
    mp_image = mp.Image(image_format=mp.ImageFormat.SRGB, data=np.ascontiguousarray(rgb))
    face_result = face_model.detect(mp_image)
    faces = [
        _face_features(np.array([[point.x * width, point.y * height] for point in landmarks], dtype=np.float32),
                       width, height)
        for landmarks in face_result.face_landmarks
    ]
    row = {
        "time_s": timestamp, "video": "camera-segment", "img_w": width, "img_h": height,
        "n_faces": len(faces), "n_hands": 0, "hand_near_face": False, "hand_near_mouth": False,
        "phone_face_dist": 9.0,
    }
    row.update({name: 0.0 for name in ("yaw", "pitch", "roll", "ear", "mar", "gaze_h", "gaze_v", "face_area")})
    for name in OBJECTS:
        row[f"{name}_conf"] = 0.0
        if name != "person":
            row[f"{name}_n"] = 0
    face_box = None
    mouth_box = None
    if faces:
        features, face_box, mouth_box = max(faces, key=lambda item: item[0]["face_area"])
        row.update(features)
        hand_result = hand_model.detect(mp_image)
        if hand_result.hand_landmarks:
            row["n_hands"] = len(hand_result.hand_landmarks)
            hand_points = np.concatenate([
                [[point.x * width, point.y * height] for point in landmarks]
                for landmarks in hand_result.hand_landmarks
            ]).astype(np.float32)
            row["hand_near_face"] = _inside(hand_points, face_box, 0.1)
            row["hand_near_mouth"] = _inside(hand_points, mouth_box, 0.3)
    detections = yolo.predict(frame, conf=0.20, classes=COCO_IDS, verbose=False)[0]
    for detection in detections.boxes:
        class_name = detections.names[int(detection.cls[0])]
        name = ALIASES.get(class_name)
        confidence = float(detection.conf[0])
        if name is None or confidence < {"phone": 0.25, "laptop": 0.40, "tv": 0.45, "remote": 0.35,
                                         "book": 0.30, "person": 0.40}.get(name, 0.30):
            continue
        row[f"{name}_conf"] = max(row[f"{name}_conf"], confidence)
        if name == "person":
            row["n_person"] += 1
        else:
            row[f"{name}_n"] += 1
        if name in ("phone", "tablet") and face_box is not None:
            object_box = [float(value) for value in detection.xyxy[0]]
            object_center = ((object_box[0] + object_box[2]) / 2, (object_box[1] + object_box[3]) / 2)
            face_center = ((face_box[0] + face_box[2]) / 2, (face_box[1] + face_box[3]) / 2)
            face_width = max(face_box[2] - face_box[0], 1.0)
            row["phone_face_dist"] = min(
                row["phone_face_dist"],
                math.hypot(object_center[0] - face_center[0], object_center[1] - face_center[1]) / face_width,
            )
    return row


def _feature_matrix(rows):
    data = pd.DataFrame(rows)
    valid_faces = data[data.n_faces == 1]
    for column in ("yaw", "pitch", "gaze_h", "gaze_v", "mar"):
        global_median = valid_faces[column].median()
        by_video = valid_faces.groupby("video")[column].agg(["median", "count"])
        baseline = by_video["median"].where(by_video["count"] >= 10, global_median)
        data[f"{column}_dev"] = (data[column] - data.video.map(baseline).fillna(global_median)).fillna(0.0)
    features = data[BASE_FEATURES + OBJECT_FEATURES].astype(float).copy()
    rolling = lambda series, operation="mean": series.rolling(
        WINDOW_FRAMES, center=True, min_periods=1
    ).agg(operation)
    features["yaw_abs_roll"] = rolling(data.yaw_dev.abs())
    features["pitch_abs_roll"] = rolling(data.pitch_dev.abs())
    features["gaze_abs_roll"] = rolling(data.gaze_h_dev.abs())
    features["mar_roll_std"] = rolling(data.mar, "std").fillna(0.0)
    features["no_face_frac"] = rolling((data.n_faces == 0).astype(float))
    features["multi_face_frac"] = rolling((data.n_faces >= 2).astype(float))
    features["hand_mouth_frac"] = rolling(data.hand_near_mouth.astype(float))
    features["phone_frac"] = rolling(((data.phone_conf > 0) | (data.tablet_conf > 0)).astype(float))
    features["book_frac"] = rolling(((data.book_conf > 0) | (data.paper_conf > 0)).astype(float))
    features["device_frac"] = rolling(((data.laptop_conf > 0) | (data.tv_conf > 0) | (data.remote_conf > 0)).astype(float))
    features["person_extra_frac"] = rolling((data.n_person >= 2).astype(float))
    return features.reindex(columns=FEATURES).replace([np.inf, -np.inf], np.nan).fillna(0.0)


def _analyze(data):
    if extractor is None or model_bundle is None:
        raise HTTPException(status_code=503, detail="Human-labeled model or inference assets are not installed")
    suffix = ".mp4" if data[:64].find(b"ftyp") >= 0 else ".webm"
    with tempfile.TemporaryDirectory() as directory:
        video_path = Path(directory) / f"camera{suffix}"
        video_path.write_bytes(data)
        capture = cv2.VideoCapture(str(video_path))
        if not capture.isOpened():
            raise HTTPException(status_code=422, detail="Uploaded video cannot be decoded")
        fps = capture.get(cv2.CAP_PROP_FPS)
        if not math.isfinite(fps) or fps <= 0:
            fps = 30.0
        source_frames = int(capture.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
        if source_frames > MAX_SOURCE_FRAMES or (source_frames and source_frames / fps > MAX_CLIP_SECONDS):
            capture.release()
            raise HTTPException(status_code=413, detail="Video segment exceeds the duration limit")
        stride = max(round(fps / SAMPLE_FPS), 1)
        rows = []
        index = 0
        while len(rows) < MAX_FRAMES and index < MAX_SOURCE_FRAMES:
            ok, frame = capture.read()
            if not ok:
                break
            if index % stride == 0:
                height, width = frame.shape[:2]
                if width > 640:
                    frame = cv2.resize(frame, (640, round(height * 640 / width)), interpolation=cv2.INTER_AREA)
                rows.append(_extract_frame(frame, index / fps, extractor))
            index += 1
        capture.release()
    if not rows:
        raise HTTPException(status_code=422, detail="Uploaded video contains no readable frames")
    matrix = _feature_matrix(rows).reindex(columns=model_bundle["features"], fill_value=0.0)
    model = model_bundle["model"]
    probabilities = model.predict_proba(matrix)
    classes = list(model.classes_)
    threshold = float(os.getenv("CHEATING_REVIEW_THRESHOLD", "0.65"))
    flags = []
    for index, row in enumerate(rows):
        scores = {LABELS[int(class_id)]: float(probabilities[index, column])
                  for column, class_id in enumerate(classes) if int(class_id) in LABELS}
        predicted = max(scores, key=scores.get)
        if predicted == "cheating" and scores[predicted] >= threshold:
            flags.append({"time_s": row["time_s"], "label": predicted, "confidence": scores[predicted]})
        elif predicted == "suspicious" and scores[predicted] >= 0.75:
            flags.append({"time_s": row["time_s"], "label": predicted, "confidence": scores[predicted]})
    return {
        "status": "analyzed",
        "model_version": str(model_bundle.get("model_version", "human-labeled-rf-v1"))[:80],
        "frames_analyzed": len(rows),
        "review_flags": flags[:100],
    }


@app.get("/health")
def health():
    return {"ok": True, "model_ready": model_bundle is not None and extractor is not None}


@app.post("/analyze")
async def analyze(request: Request):
    token = os.getenv("PROCTORING_API_TOKEN", "")
    authorization = request.headers.get("authorization", "")
    if not token or not secrets.compare_digest(authorization, f"Bearer {token}"):
        raise HTTPException(status_code=401, detail="Unauthorized")
    content_type = request.headers.get("content-type", "")
    if not content_type.startswith(("video/webm", "video/mp4")):
        raise HTTPException(status_code=415, detail="Only WebM and MP4 videos are accepted")
    content_length = request.headers.get("content-length")
    if content_length and content_length.isdigit() and int(content_length) > MAX_BYTES:
        raise HTTPException(status_code=413, detail="Video exceeds the upload limit")
    data = await request.body()
    if not data or len(data) > MAX_BYTES:
        raise HTTPException(status_code=413, detail="Video is empty or exceeds the upload limit")
    return await run_in_threadpool(_analyze_locked, data)


def _analyze_locked(data):
    with inference_lock:
        return _analyze(data)
