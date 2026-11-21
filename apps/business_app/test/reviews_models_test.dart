import 'package:flutter_test/flutter_test.dart';
import 'package:salon_business/reviews/reviews_models.dart';

void main() {
  test('rating summary stays honest when empty', () {
    expect(Rating.fromJson(null).average, isNull);
    expect(Rating.empty.share(5), 0);
    final r = Rating.fromJson({'average': 4.5, 'count': 2, 'distribution': {'4': 1, '5': 1}});
    expect(r.share(5), 0.5);
    expect(r.distribution[1], 0);
  });

  test('owner review never carries customer identity and parses the response', () {
    final r = OwnerReview.fromJson({
      'id': 'r', 'authorName': 'Sara K.', 'rating': 4, 'staffRating': null, 'staff': {'id': 's', 'name': 'Ali'}, 'comment': 'Nice',
      'response': {'text': 'Thanks', 'at': '2026-11-20T10:00:00.000Z'}, 'reported': true, 'edited': false, 'services': [{'name': 'Haircut', 'rating': 5}],
    });
    expect(r.authorName, 'Sara K.');
    expect(r.response, 'Thanks');
    expect(r.staffRating, isNull);
    expect(r.reported, isTrue);
    expect(r.services.single.name, 'Haircut');
    expect(OwnerReview.fromJson({}).response, isNull);
  });

  test('customer summary keeps money as text and formats it', () {
    final c = CustomerSummary.fromJson({'customerId': 'c', 'name': 'Rev One', 'visits': 2, 'noShows': 1, 'cancelled': 0, 'upcoming': 0, 'totalSpent': '1200.50'});
    expect(c.totalSpent, '1200.50');
    expect(pkrText(c.totalSpent), 'Rs. 1,200.50');
    expect(pkrText('450.00'), 'Rs. 450');
    expect(pkrText('abc'), 'Rs. abc');
  });

  test('customer detail parses history and reviews', () {
    final d = CustomerDetail.fromJson({
      'customerId': 'c', 'name': 'X', 'history': [{'id': 'a', 'status': 'COMPLETED', 'staffName': 'Ali', 'totalPrice': '300.00', 'services': ['Haircut']}], 'reviews': [{'id': 'r', 'rating': 5}],
    });
    expect(d.history.single.services, ['Haircut']);
    expect(d.reviews.single.rating, 5);
  });

  test('text rules match the server', () {
    expect(textProblem('  ', max: 500), isNotNull);
    expect(textProblem('  ', max: 500, required: false), isNull);
    expect(textProblem('ok', max: 500), isNull);
    expect(textProblem('<b>', max: 500), isNotNull);
    expect(textProblem('x' * 501, max: 500), isNotNull);
    expect(kReportReasons.keys, containsAll(['OFFENSIVE', 'SPAM', 'FAKE', 'PRIVATE_INFO', 'OTHER']));
    expect(ratingText(null, 0), 'No reviews yet');
    expect(ratingText(4.25, 1), '4.3 (1 review)');
  });
}
