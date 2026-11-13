import 'package:geolocator/geolocator.dart';

enum LocationStatus { unknown, granted, denied, deniedForever, serviceOff, unavailable }

class LocationResult {
  const LocationResult(this.status, {this.lat, this.lng});
  final LocationStatus status;
  final double? lat;
  final double? lng;
  bool get ok => status == LocationStatus.granted && lat != null && lng != null;
}

/// Location is OPTIONAL. The app asks only when the customer taps "Near me", uses a coarse position for that one
/// search, and keeps working by city and area when the permission is denied.
abstract class LocationService {
  Future<LocationResult> current();
}

class GeolocatorLocationService implements LocationService {
  @override
  Future<LocationResult> current() async {
    try {
      if (!await Geolocator.isLocationServiceEnabled()) return const LocationResult(LocationStatus.serviceOff);
      var permission = await Geolocator.checkPermission();
      if (permission == LocationPermission.denied) permission = await Geolocator.requestPermission();
      if (permission == LocationPermission.deniedForever) return const LocationResult(LocationStatus.deniedForever);
      if (permission == LocationPermission.denied) return const LocationResult(LocationStatus.denied);
      final p = await Geolocator.getCurrentPosition(
        locationSettings: const LocationSettings(accuracy: LocationAccuracy.low, timeLimit: Duration(seconds: 12)),
      );
      return LocationResult(LocationStatus.granted, lat: p.latitude, lng: p.longitude);
    } catch (_) {
      return const LocationResult(LocationStatus.unavailable);
    }
  }
}
