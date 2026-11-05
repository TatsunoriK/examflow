import argparse
from pathlib import Path

import joblib
import numpy as np
import pandas as pd
from sklearn.ensemble import RandomForestClassifier
from sklearn.metrics import classification_report, confusion_matrix

LABELS = {0: "normal", 1: "suspicious", 2: "cheating"}
BASE_FEATURES = [
    "n_faces", "n_person", "n_hands", "yaw", "pitch", "roll", "ear", "mar", "gaze_h", "gaze_v",
    "face_area", "hand_near_face", "hand_near_mouth", "yaw_dev", "pitch_dev", "gaze_h_dev",
    "gaze_v_dev", "mar_dev", "phone_face_dist",
]
OBJECTS = ["person", "phone", "tablet", "book", "paper", "earphone", "watch", "laptop", "tv", "remote"]
OBJECT_FEATURES = [f"{name}_conf" for name in OBJECTS]
OBJECT_FEATURES += [f"{name}_n" for name in OBJECTS if name != "person"]
TEMPORAL_FEATURES = [
    "yaw_abs_roll", "pitch_abs_roll", "gaze_abs_roll", "mar_roll_std", "no_face_frac",
    "multi_face_frac", "hand_mouth_frac", "phone_frac", "book_frac", "device_frac", "person_extra_frac",
]
FEATURES = BASE_FEATURES + OBJECT_FEATURES + TEMPORAL_FEATURES
LABEL_TO_ID = {name: index for index, name in LABELS.items()}
WINDOW_FRAMES = 15


def build_features(data):
    features = data[BASE_FEATURES + OBJECT_FEATURES].astype(float).copy()

    def rolling(series, operation="mean", min_periods=1):
        return series.groupby(data["video"], sort=False).transform(
            lambda values: values.rolling(WINDOW_FRAMES, center=True, min_periods=min_periods).agg(operation)
        )

    features["yaw_abs_roll"] = rolling(data["yaw_dev"].abs())
    features["pitch_abs_roll"] = rolling(data["pitch_dev"].abs())
    features["gaze_abs_roll"] = rolling(data["gaze_h_dev"].abs())
    features["mar_roll_std"] = rolling(data["mar"], "std", 2)
    features["no_face_frac"] = rolling((data["n_faces"] == 0).astype(float))
    features["multi_face_frac"] = rolling((data["n_faces"] >= 2).astype(float))
    features["hand_mouth_frac"] = rolling(data["hand_near_mouth"].astype(float))
    features["phone_frac"] = rolling(((data["phone_conf"] > 0) | (data["tablet_conf"] > 0)).astype(float))
    features["book_frac"] = rolling(((data["book_conf"] > 0) | (data["paper_conf"] > 0)).astype(float))
    features["device_frac"] = rolling(
        ((data["laptop_conf"] > 0) | (data["tv_conf"] > 0) | (data["remote_conf"] > 0)).astype(float)
    )
    features["person_extra_frac"] = rolling((data["n_person"] >= 2).astype(float))
    return features.reindex(columns=FEATURES).replace([np.inf, -np.inf], np.nan).fillna(0.0)


def train(data_path, labels_path, model_path):
    data = pd.read_csv(data_path, dtype={"video": str})
    labels = pd.read_csv(labels_path, dtype={"video": str})
    required_data = set(BASE_FEATURES + OBJECT_FEATURES + ["video", "frame_idx", "split"])
    required_labels = {"video", "frame_idx", "label_human"}
    if missing := required_data - set(data.columns):
        raise ValueError(f"{data_path} is missing columns: {sorted(missing)}")
    if missing := required_labels - set(labels.columns):
        raise ValueError(f"{labels_path} is missing columns: {sorted(missing)}")
    if data.duplicated(["video", "frame_idx"]).any():
        raise ValueError("The feature CSV contains duplicate video/frame_idx rows")
    if data.groupby("video")["split"].nunique().gt(1).any():
        raise ValueError("A video appears in multiple data splits")

    labels["label_human"] = labels["label_human"].fillna("").astype(str).str.strip().str.lower()
    labels = labels[labels["label_human"] != ""].copy()
    if labels.empty:
        raise ValueError("No human-reviewed labels were provided")
    if labels.duplicated(["video", "frame_idx"]).any():
        raise ValueError("The human-label CSV contains duplicate video/frame_idx rows")
    invalid = sorted(set(labels["label_human"]) - set(LABEL_TO_ID))
    if invalid:
        raise ValueError(f"Unsupported human labels: {invalid}; use {list(LABEL_TO_ID)}")
    data = data.assign(_row_id=np.arange(len(data)))
    rows = labels.merge(data, on=["video", "frame_idx"], how="left", validate="one_to_one", indicator=True)
    if rows["_merge"].ne("both").any():
        raise ValueError(f"{int(rows['_merge'].ne('both').sum())} human labels do not match an extracted frame")
    rows = rows.drop(columns="_merge")
    rows["target"] = rows["label_human"].map(LABEL_TO_ID).astype(int)
    train_rows = rows[rows["split"] == "train"]
    test_rows = rows[rows["split"] == "test"]
    if train_rows.empty or test_rows.empty:
        raise ValueError("Human-reviewed labels are required in both train and test video splits")
    if set(train_rows["target"]) != set(LABELS):
        raise ValueError("The train split must contain human labels for all three classes")
    if train_rows["video"].isin(test_rows["video"]).any():
        raise ValueError("Train and test videos overlap")

    full_features = build_features(data)
    train_features = full_features.iloc[train_rows["_row_id"].to_numpy()]
    model = RandomForestClassifier(
        n_estimators=300,
        min_samples_leaf=3,
        class_weight="balanced_subsample",
        n_jobs=-1,
        random_state=0,
    )
    model.fit(train_features, train_rows["target"])
    test_features = full_features.iloc[test_rows["_row_id"].to_numpy()]
    predictions = model.predict(test_features)
    print(f"Human-labeled training frames: {len(train_rows)} across {train_rows['video'].nunique()} videos")
    print(f"Human-labeled held-out test frames: {len(test_rows)} across {test_rows['video'].nunique()} videos")
    print(classification_report(
        test_rows["target"],
        predictions,
        labels=list(LABELS),
        target_names=[LABELS[index] for index in LABELS],
        zero_division=0,
    ))
    print("Confusion matrix (rows=true, columns=predicted):")
    print(confusion_matrix(test_rows["target"], predictions, labels=list(LABELS)))

    output = Path(model_path)
    output.parent.mkdir(parents=True, exist_ok=True)
    joblib.dump({
        "model": model,
        "features": FEATURES,
        "labels": LABELS,
        "model_version": "human-reviewed-rf-v1",
        "training_videos": sorted(train_rows["video"].unique().tolist()),
        "test_videos": sorted(test_rows["video"].unique().tolist()),
    }, output)
    print(f"Saved model bundle: {output}")


def main():
    parser = argparse.ArgumentParser(description="Train an ExamFlow review model from human-labeled extracted frames.")
    parser.add_argument("--data", required=True, help="Feature CSV exported by exam_proctoring_v2.py")
    parser.add_argument("--labels", required=True, help="CSV containing video, frame_idx and label_human")
    parser.add_argument("--model-out", default="models/exam_cheating_rf.joblib")
    args = parser.parse_args()
    train(args.data, args.labels, args.model_out)


if __name__ == "__main__":
    main()
