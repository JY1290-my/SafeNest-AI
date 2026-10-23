import cv2
from ultralytics import YOLO


def main():
    print("Loading the pose-estimation model...")
    model = YOLO("yolo11n-pose.pt")

    cap = cv2.VideoCapture(0)

    if not cap.isOpened():
        print("Cannot open the camera. Check camera permissions and the camera index.")
        cap.release()
        return

    print("Camera started. Focus the preview window and press Q to exit.")

    try:
        while True:
            success, frame = cap.read()

            if not success:
                print("Cannot read a camera frame.")
                break

            # Run pose estimation on the current camera frame.
            results = model.predict(source=frame, verbose=False)
            result = results[0]

            # Draw person boxes, keypoints and skeleton connections.
            annotated_frame = result.plot()

            cv2.imshow("Elderly Fall AI - Pose Detection", annotated_frame)

            key = cv2.waitKey(1) & 0xFF
            if key == ord("q") or key == ord("Q"):
                break

    finally:
        cap.release()
        cv2.destroyAllWindows()


if __name__ == "__main__":
    main()