"""Local bed-region setup. Geometry only on disk; every run needs confirmation."""
import json
import math
from pathlib import Path


BACKGROUND_GRACE_SECONDS = 2.0
CLEARED_REASON = "Bed area not calibrated"


def contains(polygon, point):
    """Boundary-inclusive ray casting in normalized image coordinates."""
    x, y = point
    inside = False
    for a, b in zip(polygon, polygon[1:] + polygon[:1]):
        cross = (x-a[0])*(b[1]-a[1]) - (y-a[1])*(b[0]-a[0])
        if abs(cross) < 1e-9 and min(a[0], b[0])-1e-9 <= x <= max(a[0], b[0])+1e-9 and min(a[1], b[1])-1e-9 <= y <= max(a[1], b[1])+1e-9:
            return True
        if (a[1] > y) != (b[1] > y) and x < (b[0]-a[0])*(y-a[1])/(b[1]-a[1])+a[0]:
            inside = not inside
    return inside


def validate_polygon(points):
    if not isinstance(points, (list, tuple)) or not 3 <= len(points) <= 12:
        raise ValueError("Mark 3 to 12 bed corners in boundary order")
    poly = []
    for p in points:
        if not isinstance(p, (list, tuple)) or len(p) != 2:
            raise ValueError("Invalid corner")
        x, y = map(float, p)
        if not all(math.isfinite(v) and 0 <= v <= 1 for v in (x, y)):
            raise ValueError("Corners must be inside the image")
        poly.append((x, y))
    if len(set(poly)) != len(poly):
        raise ValueError("Repeated corner")
    def orient(a, b, c):
        return (b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0])
    def intersects(a, b, c, d):
        # Including touching/collinear non-adjacent edges: reject ambiguous areas.
        return (max(min(a[0], b[0]), min(c[0], d[0])) <= min(max(a[0], b[0]), max(c[0], d[0]))
                and max(min(a[1], b[1]), min(c[1], d[1])) <= min(max(a[1], b[1]), max(c[1], d[1]))
                and orient(a,b,c)*orient(a,b,d) <= 0 and orient(c,d,a)*orient(c,d,b) <= 0)
    n = len(poly)
    for i in range(n):
        for j in range(i+1, n):
            if j == i+1 or (i == 0 and j == n-1):
                continue
            if intersects(poly[i], poly[(i+1)%n], poly[j], poly[(j+1)%n]):
                raise ValueError("Bed outline must not cross itself")
    area = abs(sum(a[0]*b[1]-b[0]*a[1] for a,b in zip(poly, poly[1:]+poly[:1])))/2
    if area < .005:
        raise ValueError("Bed outline is too small")
    return poly


class RoomCalibration:
    def __init__(self, path, source="0", profile="default", device_scope=None):
        self.path = Path(path)
        self.source, self.profile = str(source), str(profile)
        self.device_scope = device_scope
        self.polygon, self.resolution = [], None
        self.active, self.verified, self.revision = False, False, 0
        self.view_revision = 0
        self.verification_state = "unconfirmed"
        self.uncertain_since = None
        self.reason = "Bed area not calibrated"
        try:
            if self.path.stat().st_size > 65536:
                raise ValueError("Oversized profile")
            obj = json.loads(self.path.read_text(encoding="utf-8"))
            expected_version = 2 if device_scope is not None else 1
            if (obj.get("version") != expected_version or obj.get("source") != self.source
                or obj.get("profile") != self.profile or obj.get("device_scope") != device_scope):
                raise ValueError("Different camera/setup profile")
            if obj.get("cleared") is True:
                if obj.get("bed_polygon") != []:
                    raise ValueError("Invalid cleared profile")
            else:
                self.polygon = validate_polygon(obj["bed_polygon"])
                self.reason = "Saved outline needs visual confirmation this run"
        except FileNotFoundError:
            pass
        except (OSError, ValueError, TypeError, KeyError, AttributeError):
            self.polygon = []
            self.reason = "Profile unavailable; recalibrate"

    def invalidate(self, reason, view_changed=False):
        if view_changed:
            self.view_revision += 1
        if self.active or self.reason != reason:
            self.revision += 1
        self.active = self.verified = False
        self.verification_state = "view_changed" if view_changed else "unconfirmed"
        self.uncertain_since = None
        self.reason = reason

    def clear(self):
        """Persist an empty outline for this camera/profile and clear its state.

        The calibration path is already scoped by device, camera source and
        view profile. Keep an explicit cleared record so a repeated camera
        registration cannot import a legacy outline over the reset.
        """
        self._write_profile([], None, cleared=True)
        changed = (bool(self.polygon) or self.active or self.verified
                   or self.verification_state != "unconfirmed"
                   or self.reason != CLEARED_REASON)
        self.polygon = []
        self.resolution = None
        self.active = self.verified = False
        self.verification_state = "unconfirmed"
        self.uncertain_since = None
        self.reason = CLEARED_REASON
        if changed:
            self.revision += 1
        return changed

    def verify(self, usable, reason, *, state="occluded", now=None):
        """Soft verification never resets motion history or moves the reference.

        A held polygon is only an uncertain location hint, never resting proof.
        Possible camera motion disables that hint until the original view matches.
        """
        if not self.active:
            return
        if usable:
            self.verification_state, self.uncertain_since = "verified", None
        else:
            if self.verified:
                self.uncertain_since = now
            # Do not revive old geometry after a supported movement candidate
            # simply because a subsequent frame has too few background matches.
            if self.verification_state == "motion_pending":
                state = "motion_pending"
            self.verification_state = state
        self.verified, self.reason = bool(usable), reason

    def holding_location(self, now):
        return (self.active and not self.verified and self.verification_state == "occluded"
                and self.uncertain_since is not None
                and 0 <= now-self.uncertain_since <= BACKGROUND_GRACE_SECONDS)

    def verification_label(self, now):
        if not self.polygon:
            return "needs calibration"
        if self.holding_location(now):
            return "occluded (2s location grace; not verified)"
        return {"verified":"verified", "occluded":"occluded; location unknown",
                "motion_pending":"possible movement; location unknown",
                "view_changed":"view changed; recalibrate"}.get(self.verification_state,"unconfirmed")

    def describe(self, now):
        return "Calibration: " + self.verification_label(now) + "; " + self.reason

    def view(self, size):
        size = tuple(size)
        if self.resolution is not None and size != self.resolution:
            self.invalidate("Image dimensions changed; recalibrate", view_changed=True)
        self.resolution = size

    def _write_profile(self, polygon, resolution, *, cleared=False):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        obj = {"version": 1, "source": self.source, "profile": self.profile,
               "resolution": resolution, "bed_polygon": polygon}
        if self.device_scope is not None:
            obj.update(version=2, device_scope=self.device_scope)
        if cleared:
            obj["cleared"] = True
        temp = self.path.with_suffix(self.path.suffix + ".tmp")
        try:
            temp.write_text(json.dumps(obj, indent=2), encoding="utf-8")
            temp.replace(self.path)
        finally:
            try:
                temp.unlink()
            except OSError:
                pass

    def confirm(self, points, size):
        poly = validate_polygon(points)
        w, h = size
        if w <= 0 or h <= 0:
            raise ValueError("No camera image")
        self._write_profile(poly, list(size))
        self.polygon, self.resolution = poly, tuple(size)
        self.active = self.verified = True
        self.verification_state, self.uncertain_since = "verified", None
        self.revision += 1
        self.reason = "Bed area calibrated; keep camera still"

    def zone(self, points, confidence, size, keypoint_conf=.4, indices=(5, 6, 11, 12)):
        if not self.active or not self.verified or tuple(size) != self.resolution or points is None or confidence is None:
            return "unknown"
        return self._polygon_zone(points,confidence,size,keypoint_conf,indices)

    def held_zone(self, points, confidence, size, now, keypoint_conf=.4):
        """Short-lived estimate; callers must not publish it as a verified zone."""
        if not self.holding_location(now) or tuple(size) != self.resolution:
            return "unknown"
        return self._polygon_zone(points,confidence,size,keypoint_conf,(5,6,11,12))

    def _polygon_zone(self, points, confidence, size, keypoint_conf, indices):
        try:
            if any(confidence[i] < keypoint_conf for i in indices):
                return "unknown"
            w, h = size
            coords = [(float(points[i][0])/w, float(points[i][1])/h) for i in indices]
            if any(not math.isfinite(v) or not 0 <= v <= 1 for p in coords for v in p):
                return "unknown"
            hits = [contains(self.polygon, p) for p in coords]
            # Default: both shoulders AND both hips. Entry observation may check
            # both hips only for sitting; resting still requires all four points.
            return "inside" if all(hits) else "outside" if not any(hits) else "boundary"
        except (IndexError, TypeError, ValueError, ZeroDivisionError):
            return "unknown"


class ViewGuard:
    """Compare a fixed reference outside the deformable bed and person boxes.

    Weak/occluded matches are not camera-motion evidence. Only repeated,
    consistent supported transforms invalidate the view. Never reanchor.
    """
    def __init__(self, cv, interval=.5, shift_limit=.02):
        self.cv, self.interval, self.shift_limit = cv, interval, shift_limit
        self.reference, self.bed = None, []
        self.checked_at = -math.inf
        self.motion_checks = 0
        self.pending_displacement = None
        self.reference_gray = self.reference_mask = None
        self.diagnostic = ""

    def features(self, frame, boxes):
        import numpy as np
        cv = self.cv
        h, w = frame.shape[:2]
        scale = min(1., 480/w)
        gray = cv.cvtColor(frame, cv.COLOR_BGR2GRAY)
        gray = cv.resize(gray, (round(w*scale), round(h*scale)))
        mask = np.full(gray.shape, 255, np.uint8)
        if self.bed:
            polygon = np.int32([(round(x*gray.shape[1]), round(y*gray.shape[0])) for x,y in self.bed])
            cv.fillPoly(mask, [polygon], 0)
            cv.polylines(mask, [polygon], True, 0, 12)  # Exclude bedding edges too.
        for x1,y1,x2,y2 in boxes:
            cv.rectangle(mask, (max(0,round(x1*scale)-15),max(0,round(y1*scale)-15)),
                         (round(x2*scale)+15,round(y2*scale)+15), 0, -1)
        keys, desc = cv.ORB_create(nfeatures=600).detectAndCompute(gray, mask)
        coords = np.array([k.pt for k in keys], dtype=np.float32).reshape(-1,2)
        return coords, desc, (gray.shape[1],gray.shape[0]), mask, gray

    def appearance(self, gray, mask, matrix=None):
        """Independent, exposure-normalized checks across textured background tiles.

        Identity agreement can reject an aliased feature transform. A proposed
        move must actually improve alignment; sparse inliers alone cannot do so.
        Masked bed/person pixels never vote. Flat or hidden views give no proof.
        """
        import numpy as np
        cv = self.cv
        h,w = gray.shape
        gray = cv.GaussianBlur(gray,(3,3),0)
        if matrix is not None:
            gray = cv.warpPerspective(gray,matrix,(w,h),flags=cv.INTER_LINEAR | cv.WARP_INVERSE_MAP)
            mask = cv.warpPerspective(mask,matrix,(w,h),flags=cv.INTER_NEAREST | cv.WARP_INVERSE_MAP)
            mask = cv.erode(mask,np.ones((5,5),np.uint8))
        valid = (mask != 0) & (self.reference_mask != 0)
        scores, centers = [], []
        for row in range(6):
            for col in range(8):
                x1,x2 = max(2,col*w//8),min(w-2,(col+1)*w//8)
                y1,y2 = max(2,row*h//6),min(h-2,(row+1)*h//6)
                keep = valid[y1:y2,x1:x2]
                if keep.sum() < max(100,keep.size*.5):
                    continue
                a = self.reference_gray[y1:y2,x1:x2][keep].astype(np.float32)
                b = gray[y1:y2,x1:x2][keep].astype(np.float32)
                if a.std() < 8 or b.std() < 5:
                    continue
                a -= a.mean();b -= b.mean()
                score = float(np.dot(a,b)/(np.linalg.norm(a)*np.linalg.norm(b)))
                if matrix is not None:
                    # A fitted homography and resize are not pixel-exact. Permit
                    # only +/-2 px residual per tile, far below a view-change
                    # displacement, and erode the mask for every candidate.
                    correlations = cv.matchTemplate(gray[y1-2:y2+2,x1-2:x2+2],
                        self.reference_gray[y1:y2,x1:x2],cv.TM_CCOEFF_NORMED,
                        mask=keep.astype(np.uint8))
                    finite = correlations[np.isfinite(correlations)]
                    if finite.size:
                        score = float(finite.max())
                if not math.isfinite(score):
                    continue
                scores.append(score)
                yy,xx = np.nonzero(keep)
                centers.append((x1+xx.mean(),y1+yy.mean()))
        if len(scores) < 6:
            return {"supported":False,"score":0.,"agree":0.,"tiles":len(scores)}
        centers = np.float32(centers)
        span = np.ptp(centers,axis=0)/np.float32((w,h))
        area = cv.contourArea(cv.convexHull(centers))/(w*h)
        return {"supported":bool(span[0]>=.25 and span[1]>=.15 and area>=.02),
                "score":float(np.median(scores)),"agree":float(np.mean(np.array(scores)>=.8)),
                "tiles":len(scores)}

    def supported(self, points, size):
        # Geometric spread is required; a fixed count of occupied quadrants
        # incorrectly rejects a valid bed view when a person covers one side.
        import numpy as np
        if len(points) < 12:
            return False
        span = np.ptp(points, axis=0) / np.float32(size)
        area = self.cv.contourArea(self.cv.convexHull(points)) / (size[0]*size[1])
        return bool(span[0] >= .2 and span[1] >= .1 and area >= .0125)

    def capture(self, frame, boxes, bed=None):
        self.bed = list(bed or [])
        f = self.features(frame, boxes)
        if len(f[0]) < 20 or f[1] is None or not self.supported(f[0], f[2]):
            self.reference = None
            self.reference_gray = self.reference_mask = None
            return False
        self.reference = f[:3]
        # Only this one masked background reference stays in RAM. It is neither
        # saved as an image nor sent with status/video/cloud metadata.
        self.reference_mask = f[3].copy()
        background = self.cv.GaussianBlur(f[4],(3,3),0)
        self.reference_gray = self.cv.bitwise_and(background,background,mask=f[3])
        self.checked_at, self.motion_checks = -math.inf, 0
        self.pending_displacement = None
        self.diagnostic = "Background reference captured"
        return True

    def check(self, frame, boxes, now):
        import numpy as np
        if now-self.checked_at < self.interval:
            return None
        self.checked_at = now
        self.diagnostic = "Background verification unavailable"
        def unverified(message):
            self.motion_checks = 0
            self.pending_displacement = None
            return message + "; bed context paused"
        if self.reference is None or self.reference_gray is None:
            return unverified("Fixed background reference unavailable")
        old, descriptors, size = self.reference
        current, desc, current_size, mask, gray = self.features(frame, boxes)
        if current_size != size:
            return unverified("Background image dimensions differ")
        identity = self.appearance(gray,mask)
        self.diagnostic = f"Background: identity {identity['score']:.2f}; {identity['tiles']} tiles"
        if identity['supported'] and identity['score']>=.92 and identity['agree']>=.8:
            # Strong unchanged appearance takes precedence over repetitive ORB
            # matches; it does not automatically replace the original reference.
            self.motion_checks = 0
            self.pending_displacement = None
            return "verified"
        if desc is None or len(current) < 20:
            return unverified("Fixed background obscured or insufficient")
        pairs = self.cv.BFMatcher(self.cv.NORM_HAMMING).knnMatch(descriptors, desc, k=2)
        reverse_pairs = self.cv.BFMatcher(self.cv.NORM_HAMMING).knnMatch(desc, descriptors, k=2)
        reverse = {m.queryIdx:m.trainIdx for pair in reverse_pairs if len(pair)==2
                   for m,n in [pair] if m.distance < .75*n.distance}
        good = [m for pair in pairs if len(pair)==2 for m,n in [pair]
                if m.distance < .75*n.distance and reverse.get(m.trainIdx) == m.queryIdx
                and mask[min(mask.shape[0]-1,round(old[m.queryIdx][1])),
                                                      min(mask.shape[1]-1,round(old[m.queryIdx][0]))] != 0]
        if len(good) < 12:
            return unverified("Cannot verify fixed background")
        src = np.float32([old[m.queryIdx] for m in good])
        dst = np.float32([current[m.trainIdx] for m in good])
        matrix, inliers = self.cv.findHomography(src, dst, self.cv.RANSAC, 3.)
        if matrix is None or inliers is None or inliers.sum() < 12 or inliers.mean() < .6:
            return unverified("Cannot verify fixed background")
        keep = inliers.ravel().astype(bool)
        if not self.supported(src[keep], size) or not self.supported(dst[keep], size):
            return unverified("Insufficient fixed-background spread")
        grid = np.float32([[[x*size[0],y*size[1]]] for x,y in ((0,0),(1,0),(1,1),(0,1),(.5,.5))])
        moved = self.cv.perspectiveTransform(grid,matrix)
        displacement = (moved-grid)/np.float32(size)
        shift = np.linalg.norm(displacement,axis=2).max()
        if not np.isfinite(shift):
            return unverified("Cannot verify fixed background")
        if shift > self.shift_limit:
            aligned = self.appearance(gray,mask,matrix)
            self.diagnostic = (f"Shift {shift:.3f}; inliers {int(inliers.sum())}; "
                               f"alignment {aligned['score']:.2f} vs {identity['score']:.2f}")
            if (not aligned['supported'] or aligned['score']<.8 or aligned['agree']<.75
                    or aligned['score']-identity['score']<.15):
                return unverified("Background shift lacks independent image support")
            consistent = (self.pending_displacement is not None and
                          np.linalg.norm(displacement-self.pending_displacement,axis=2).max() <= self.shift_limit)
            self.motion_checks = self.motion_checks+1 if consistent else 1
            self.pending_displacement = displacement
            self.diagnostic += f"; checks {self.motion_checks}/2"
            return ("Camera view changed; recalibrate" if self.motion_checks >= 2
                    else "Possible camera movement; bed context paused")
        self.motion_checks = 0
        self.pending_displacement = None
        return "verified"


class CalibrationUI:
    """Non-blocking controls on the existing local preview; inference keeps running."""
    def __init__(self, cv, window, calibration):
        self.cv, self.window, self.calibration = cv, window, calibration
        self.guard = ViewGuard(cv)
        self.editing, self.points, self.size = False, [], None
        self.message = ""
        self.pending_key = None
        self.drag_index = None
        self.observed_at = 0.
        cv.namedWindow(window, cv.WINDOW_AUTOSIZE)
        cv.setMouseCallback(window, self.mouse)

    def mouse(self, event, x, y, flags, param):
        if self.size is None:
            return
        if event == self.cv.EVENT_LBUTTONDOWN and y < 28:
            if x < 200:
                self.begin()
            elif x < 445:
                self.pending_key = ord('b')
            elif x < 530:
                self.pending_key = ord('r')
            elif x < 640:
                self.pending_key = ord('e')
        elif self.editing and event == self.cv.EVENT_LBUTTONDOWN:
            w,h = self.size
            point = (min(1,max(0,x/w)),min(1,max(0,(y-28)/h)))
            self.drag_index = next((i for i,p in enumerate(self.points)
                if math.hypot((p[0]-point[0])*w,(p[1]-point[1])*h) <= 12), None)
            if self.drag_index is None and len(self.points) < 12:
                self.points.append(point)
        elif self.editing and event == getattr(self.cv, 'EVENT_MOUSEMOVE', 0) and self.drag_index is not None:
            w,h = self.size
            self.points[self.drag_index] = (min(1,max(0,x/w)),min(1,max(0,(y-28)/h)))
        elif event == getattr(self.cv, 'EVENT_LBUTTONUP', 4):
            self.drag_index = None
        elif self.editing and event == self.cv.EVENT_RBUTTONDOWN and self.points:
            self.points.pop()
            self.drag_index = None

    def begin(self):
        self.calibration.invalidate("Calibration in progress")
        self.editing, self.points, self.message = True, [], ""
        self.drag_index = None

    def observe(self, frame, boxes, now):
        self.observed_at = now
        self.size = (frame.shape[1],frame.shape[0])
        self.calibration.view(self.size)
        if self.calibration.active:
            try:
                reason = self.guard.check(frame,boxes,now)
            except (self.cv.error, ValueError, TypeError, IndexError):
                reason = "Background check unavailable; bed context paused"
            if reason == "verified":
                self.calibration.verify(True, "Bed area calibrated; keep camera still", now=now)
            elif reason and reason.startswith("Camera view changed"):
                self.message = ""
                detail = getattr(self.guard,"diagnostic","")
                if isinstance(detail,str) and detail:
                    reason += "; " + detail
                self.calibration.invalidate(reason, view_changed=True)
            elif reason:
                self.message = ""
                state = "motion_pending" if reason.startswith("Possible camera movement") else "occluded"
                self.calibration.verify(False, reason, state=state, now=now)

    def handle(self, key, frame, boxes):
        if self.pending_key is not None and key in (-1,255):
            key = self.pending_key
        self.pending_key = None
        if key in (ord('c'),ord('C')):
            self.begin()
        elif key in (ord('e'),ord('E')):
            self.calibration.invalidate("Editing bed outline; confirmation required")
            self.editing, self.points = True, list(self.calibration.polygon)
            self.drag_index = None
            self.message = "Drag corners to adjust; B / Enter to confirm"
        elif key in (ord('r'),ord('R')):
            try:
                self.calibration.clear()
            except OSError:
                self.calibration.invalidate("Bed-zone reset could not be saved; calibration inactive")
                self.editing, self.points = False, []
                self.drag_index = None
                self.message = "Could not clear the saved bed zone. Check file access and try again."
                return
            self.editing, self.points = True, []
            self.drag_index = None
            self.guard = ViewGuard(self.cv)
            self.message = "Bed zone cleared — mark 3–12 points, then press Enter to save."
        elif key == 27:
            self.editing = False  # Never re-enable an old calibration on cancel.
            self.drag_index = None
        elif key in (8,127) and self.points:
            self.points.pop()
            self.drag_index = None
        elif key in (10,13,ord('b'),ord('B')):
            points = self.points if self.editing else self.calibration.polygon
            try:
                if not points and not self.editing:
                    raise ValueError("No saved outline. Press C and mark the mattress first")
                validate_polygon(points)
                if not self.guard.capture(frame,boxes,points):
                    raise ValueError("Need fixed background detail outside the bed; widen view")
                self.calibration.confirm(points,self.size)
                self.editing = False
                self.drag_index = None
                self.message = "Outline confirmed. B / Enter checks the bed, not the person's condition"
            except (OSError, ValueError, self.cv.error) as exc:
                self.calibration.invalidate("Calibration incomplete")
                self.message = str(exc)[:110]

    def overlay(self, frame):
        import numpy as np
        cv = self.cv
        poly = self.points if self.editing else self.calibration.polygon
        if poly and self.size:
            w,h = self.size
            points = np.int32([(round(x*w),round(y*h)) for x,y in poly])
            color = ((0,220,255) if self.editing
                     else (0,220,0) if self.calibration.active and self.calibration.verified
                     else (0,0,255) if self.calibration.verification_state == "view_changed"
                     else (0,220,255))
            cv.polylines(frame,[points],not self.editing,color,2)
            for p in points: cv.circle(frame,tuple(p),4,color,-1)
        if self.editing and self.points:
            calibration_status = "editing; not saved"
        else:
            calibration_status = self.calibration.verification_label(self.observed_at)
        lines = ["Calibration: " + calibration_status,
                 self.calibration.reason]
        diagnostic = getattr(self.guard,"diagnostic","")
        if isinstance(diagnostic,str) and diagnostic:
            lines.append(diagnostic)
        if self.editing: lines += ["Click / drag corners | right click undo | Enter save | Esc cancel"]
        if self.message: lines += [self.message]
        wrapped = []
        for line in lines:
            # OpenCV's Hershey font has no Unicode dash glyphs.
            line = line.replace("—", "-").replace("–", "-")
            part = ""
            for word in line.split():
                candidate = (part + " " + word).strip()
                if part and cv.getTextSize(candidate,cv.FONT_HERSHEY_SIMPLEX,.4,1)[0][0] > frame.shape[1]-20:
                    wrapped.append(part)
                    part = word
                else:
                    part = candidate
            if part:
                wrapped.append(part)
        for i,line in enumerate(wrapped):
            cv.putText(frame,line,(10,frame.shape[0]-12-20*(len(wrapped)-i-1)),
                       cv.FONT_HERSHEY_SIMPLEX,.4,(0,220,255),1)

    def local_view(self, frame):
        cv = self.cv
        # A dedicated strip keeps setup clicks outside camera coordinates/video.
        view = cv.copyMakeBorder(frame,28,0,0,0,cv.BORDER_CONSTANT,value=(25,25,25))
        cv.rectangle(view,(200,0),(444,27),(45,65,55),-1)
        cv.rectangle(view,(445,0),(529,27),(55,55,65),-1)
        cv.putText(view,"Camera setup [C]",(8,19),cv.FONT_HERSHEY_SIMPLEX,.5,(255,255,255),1)
        cv.putText(view,"Confirm [B / Enter]",(210,19),cv.FONT_HERSHEY_SIMPLEX,.45,(255,255,255),1)
        cv.putText(view,"Reset [R]",(451,19),cv.FONT_HERSHEY_SIMPLEX,.4,(230,230,230),1)
        cv.putText(view,"Edit [E]",(540,19),cv.FONT_HERSHEY_SIMPLEX,.4,(230,230,230),1)
        return view
