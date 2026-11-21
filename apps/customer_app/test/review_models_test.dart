import 'package:flutter_test/flutter_test.dart';
import 'package:saloon/reviews/review_models.dart';

void main() {
  test('rating summary keeps "no reviews" honest and computes bar shares', () {
    final empty = RatingSummary.fromJson(null);
    expect(empty.average, isNull);
    expect(empty.count, 0);
    expect(empty.share(5), 0);
    final s = RatingSummary.fromJson({'average': 4.33, 'count': 3, 'distribution': {'1': 0, '2': 0, '3': 1, '4': 1, '5': 1}});
    expect(s.average, 4.33);
    expect(s.share(5), closeTo(1 / 3, 1e-9));
    expect(s.distribution[3], 1);
    expect(RatingSummary.fromJson({'distribution': 'oops'}).distribution.length, 5);
  });

  test('a public review parses with and without the optional parts', () {
    final r = PublicReview.fromJson({
      'id': 'r1', 'authorName': 'Sara K.', 'rating': 5, 'staffRating': 4, 'staffName': 'Ali', 'comment': 'Great',
      'services': [{'serviceId': 's1', 'name': 'Haircut', 'rating': 5}], 'response': {'text': 'Thank you', 'at': '2026-11-20T10:00:00.000Z'},
      'createdAt': '2026-11-19T10:00:00.000Z', 'edited': true,
    });
    expect(r.services.single.name, 'Haircut');
    expect(r.response?.text, 'Thank you');
    expect(r.edited, isTrue);
    final bare = PublicReview.fromJson({'id': 'r2'});
    expect(bare.authorName, 'Customer');
    expect(bare.staffRating, isNull);
    expect(bare.response, isNull);
    expect(bare.comment, isNull);
  });

  test('my review: hidden state, reason and the edit window come from the server', () {
    final r = MyReview.fromJson({
      'id': 'r1', 'appointmentId': 'a1', 'salon': {'id': 's', 'name': 'Rose'}, 'staff': {'id': 'x', 'name': 'Ali'}, 'rating': 3,
      'status': 'HIDDEN', 'hiddenReason': 'Not about this salon', 'canEdit': false, 'edited': false,
    });
    expect(r.isHidden, isTrue);
    expect(r.hiddenReason, 'Not about this salon');
    expect(r.canEdit, isFalse);
    expect(r.salonName, 'Rose');
    expect(r.staffName, 'Ali');
    expect(MyReview.fromJson({}).status, 'PUBLISHED');
  });

  test('pending visits list the services that can be rated', () {
    final p = PendingReview.fromJson({
      'appointmentId': 'a1', 'salon': {'id': 's', 'name': 'Rose'}, 'staff': {'id': 'x', 'name': 'Ali'}, 'visitAt': '2026-11-19T10:00:00.000Z',
      'reviewBefore': '2026-12-19T10:00:00.000Z', 'services': [{'serviceId': 'h', 'name': 'Haircut'}, {'serviceId': 'b', 'name': 'Beard'}],
    });
    expect(p.services.map((s) => s.name), ['Haircut', 'Beard']);
    expect(p.reviewBefore, isNotNull);
    expect(PendingReview.fromJson({}).services, isEmpty);
  });

  test('favourites and labels never invent a rating', () {
    final f = FavouriteSalon.fromJson({'salonId': 's', 'name': 'Rose', 'city': 'Lahore', 'area': 'DHA', 'rating': null, 'ratingCount': 0, 'coverUrl': null});
    expect(f.rating, isNull);
    expect(ratingLabel(f.rating, f.ratingCount), 'No reviews yet');
    expect(ratingLabel(4.333, 3), '4.3 (3 reviews)');
    expect(ratingLabel(5, 1), '5.0 (1 review)');
    expect(ratingLabel(4.5, 0), 'No reviews yet');
  });

  test('star and comment validation matches the server rules', () {
    for (final ok in [1, 2, 3, 4, 5]) {
      expect(isValidStars(ok), isTrue);
    }
    for (final bad in [null, 0, 6, -1]) {
      expect(isValidStars(bad), isFalse);
    }
    expect(cleanComment('   '), isNull);
    expect(cleanComment('  hi  '), 'hi');
    expect(commentProblem(null), isNull);
    expect(commentProblem('nice'), isNull);
    expect(commentProblem('<b>x</b>'), isNotNull);
    expect(commentProblem('x' * (kReviewCommentMax + 1)), isNotNull);
    expect(commentProblem('x' * kReviewCommentMax), isNull);
  });
}
